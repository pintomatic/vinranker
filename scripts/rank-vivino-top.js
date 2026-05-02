#!/usr/bin/env node
/**
 * rank-vivino-top.js
 *
 * Flip-search: score all ~9K Vivino wines by value, take the top candidates,
 * then query Vinmonopolet to find which ones are stocked in Norway.
 *
 * Usage: node scripts/rank-vivino-top.js [--top 150] [--min-reviews 30] [--force]
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { DATA_DIR, fetchJson, jaroWinkler, normalizeText, sleep, writeJson } = require("./common");

const RATING_FLOOR = 3.3;
const EXPONENT = 2;
const MIN_REVIEWS = Number(process.argv.find((a) => a.startsWith("--min-reviews="))?.split("=")[1] || 30);
const TOP_N = Number(process.argv.find((a) => a.startsWith("--top="))?.split("=")[1] || 150);
const FORCE = process.argv.includes("--force");
// Source A wines under this EUR price are table wines not exported to Norway
const MIN_PRICE_A = Number(process.argv.find((a) => a.startsWith("--min-price-a="))?.split("=")[1] || 8);
const OUT_FILE = path.join(DATA_DIR, "vivino-top-matched.json");
const CACHE_FILE = path.join(DATA_DIR, "vivino-top-cache.json");

// Score a Vivino wine by value. Price is the international retail price in local currency.
function valueScore(rating, price) {
  if (!rating || rating <= RATING_FLOOR || !price || price <= 0) return 0;
  return Math.pow(rating - RATING_FLOOR, EXPONENT) * 100 / price;
}

function loadDatasetA() {
  const csvPath = path.join(DATA_DIR, "vivino-dataset-a.csv");
  if (!fs.existsSync(csvPath)) return [];
  // Double-encoded UTF-8 stored as Latin-1
  const rawBytes = fs.readFileSync(csvPath, "latin1");
  const raw = Buffer.from(rawBytes, "latin1").toString("utf8");
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  return records.map((r) => ({
    source: "offline-a",
    winery: (r.Winery || "").trim(),
    wineName: (r.Wine || "").trim(),
    rating: parseFloat(r.Rating) || 0,
    reviews: parseInt(r.num_review, 10) || 0,
    price: parseFloat(r.price) || 0,
    country: (r.Country || "").trim(),
    region: (r.Region || "").trim(),
  })).filter((w) => w.rating > 0 && w.price >= MIN_PRICE_A && w.reviews >= MIN_REVIEWS);
}

function loadDatasetB() {
  const csvPath = path.join(DATA_DIR, "vivino-dataset-b.csv");
  if (!fs.existsSync(csvPath)) return [];
  const raw = fs.readFileSync(csvPath, "utf8");
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  return records.map((r) => ({
    source: "offline-b",
    winery: (r.Winery || "").trim(),
    wineName: (r.WineName || "").trim(),
    rating: parseFloat(r.Rating) || 0,
    reviews: parseInt((r.NumberOfRatings || "").replace(/[^\d]/g, ""), 10) || 0,
    price: parseFloat(r.Price) || 0,
    country: (r.Country || "").trim(),
    region: "",
  })).filter((w) => w.rating > 0 && w.price > 0 && w.reviews >= MIN_REVIEWS);
}

async function searchVinmonopolet(winery, wineName) {
  // Build query: winery + first meaningful words of wine name (strip year)
  const strippedName = wineName.replace(/\b(19|20)\d{2}\b/g, "").trim();
  const query = encodeURIComponent(`${winery} ${strippedName}`.trim());
  const url = `https://www.vinmonopolet.no/vmpws/v2/vmp/products/search?fields=FULL&pageSize=5&currentPage=0&q=${query}&searchType=product`;
  const data = await fetchJson(url);
  const products = data?.products || [];
  if (!products.length) return null;

  // Find best match by name similarity
  const fullVivinoName = `${winery} ${strippedName}`.toLowerCase();
  let bestProduct = null;
  let bestScore = 0;

  for (const p of products) {
    const vmpName = (p.name || "").toLowerCase();
    const sim = jaroWinkler(fullVivinoName, vmpName);
    if (sim > bestScore && sim >= 0.55) {
      bestScore = sim;
      bestProduct = p;
    }
  }

  if (!bestProduct) return null;

  const volumeCl = Number(bestProduct.volume?.value || 75);
  const rawPrice = Number(bestProduct.price?.value || 0);
  const price75 = volumeCl ? rawPrice / (volumeCl / 75) : rawPrice;

  return {
    vmpCode: bestProduct.code,
    vmpName: bestProduct.name,
    vmpPrice75: Number(price75.toFixed(2)),
    vmpUrl: bestProduct.url ? `https://www.vinmonopolet.no${bestProduct.url}` : "",
    vmpImage: bestProduct.images?.find((i) => i.format === "product")?.url || bestProduct.images?.[0]?.url || "",
    vmpCountry: bestProduct.main_country?.name || "",
    matchScore: Number(bestScore.toFixed(3)),
  };
}

(async () => {
  // Load and score all Vivino wines
  const rawA = loadDatasetA();
  const rawB = loadDatasetB();

  // Deduplicate by winery::wineName (Source A has many duplicates)
  const dedup = (wines) => {
    const seen = new Map();
    wines.forEach((w) => {
      const k = `${w.source}::${w.winery}::${w.wineName}`;
      if (!seen.has(k)) seen.set(k, w);
    });
    return [...seen.values()];
  };
  const a = dedup(rawA);
  const b = dedup(rawB);
  console.log(`Loaded ${a.length} unique from Source A, ${b.length} unique from Source B (min ${MIN_REVIEWS} reviews, min price A €${MIN_PRICE_A})`);

  // Score each source separately and take top-N from each
  // Source A: Spanish wines at €8-20, strong value scores
  // Source B: global quality wines at $14-25, internationally distributed
  const halfN = Math.floor(TOP_N / 2);
  const scoreAndSort = (wines) =>
    wines.map((w) => ({ ...w, vivinoScore: valueScore(w.rating, w.price) }))
      .filter((w) => w.vivinoScore > 0)
      .sort((x, y) => y.vivinoScore - x.vivinoScore);

  const topA = scoreAndSort(a).slice(0, halfN);
  const topB = scoreAndSort(b).slice(0, b.length); // search ALL of Source B (only 748 wines)
  const topWines = [...topA, ...topB];

  console.log(`Searching ${topA.length} top Source A wines + all ${topB.length} Source B wines = ${topWines.length} total`);

  // Load cache
  const cache = fs.existsSync(CACHE_FILE) ? JSON.parse(fs.readFileSync(CACHE_FILE, "utf8")) : {};
  const results = [];
  let newSearches = 0;
  let cacheHits = 0;

  for (let i = 0; i < topWines.length; i++) {
    const wine = topWines[i];
    const cacheKey = `${wine.source}::${wine.winery}::${wine.wineName}`;

    if (!FORCE && cache[cacheKey] !== undefined) {
      if (cache[cacheKey]) results.push({ ...wine, vmp: cache[cacheKey] });
      cacheHits++;
      continue;
    }

    process.stdout.write(`[${i + 1}/${topWines.length}] ${wine.winery} ${wine.wineName}... `);
    try {
      const vmp = await searchVinmonopolet(wine.winery, wine.wineName);
      cache[cacheKey] = vmp || false;
      if (vmp) {
        results.push({ ...wine, vmp });
        console.log(`✓ ${vmp.vmpName} @ ${vmp.vmpPrice75} NOK`);
      } else {
        console.log("not found");
      }
      newSearches++;
      // Save incrementally so progress survives kills/timeouts
      if (newSearches % 10 === 0) fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
    } catch (err) {
      console.log(`ERROR: ${err.message}`);
      // Don't cache errors
    }

    await sleep(600);
  }

  // Final cache save
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));

  // Compute final scores using VMP price
  const matched = results.map((w) => ({
    source: w.source,
    vmpCode: w.vmp.vmpCode,
    wine_name: w.vmp.vmpName,
    winery: w.winery,
    country: w.vmp.vmpCountry || w.country,
    region: w.region,
    vmpPrice75: w.vmp.vmpPrice75,
    vmpUrl: w.vmp.vmpUrl,
    vmpImage: w.vmp.vmpImage,
    vivinoRating: w.rating,
    vivinoReviews: w.reviews,
    vivinoPrice: w.price,
    vivinoScore: Number(w.vivinoScore.toFixed(3)),
    finalScore: Number(valueScore(w.rating, w.vmp.vmpPrice75).toFixed(3)),
    matchScore: w.vmp.matchScore,
  }));

  matched.sort((a, b) => b.finalScore - a.finalScore);

  writeJson(OUT_FILE, {
    generatedAt: new Date().toISOString(),
    searched: topWines.length,
    matched: matched.length,
    cacheHits,
    newSearches,
    wines: matched,
  });

  console.log(`\nDone. ${matched.length}/${topWines.length} found in Vinmonopolet.`);
  console.log(`Cache hits: ${cacheHits}, new searches: ${newSearches}`);
  console.log(`Output: ${OUT_FILE}`);

  if (matched.length > 0) {
    console.log("\nTop 10 by Norwegian value score:");
    matched.slice(0, 10).forEach((w, i) =>
      console.log(`  ${i + 1}. ${w.wine_name} @ ${w.vmpPrice75} NOK — Vivino ${w.vivinoRating} (${w.vivinoReviews} reviews) — score ${w.finalScore}`)
    );
  }
})();
