#!/usr/bin/env node
/**
 * parse-flip-output.js
 *
 * Extract matches from the rank-vivino-top.js output file.
 * Cross-references with Vivino datasets to get ratings, reviews, prices.
 * Outputs vivino-top-matched.json in the same format as the main script.
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { DATA_DIR, writeJson } = require("./common");

const OUTPUT_FILE = process.argv[2];
if (!OUTPUT_FILE) {
  console.error("Usage: node scripts/parse-flip-output.js <output-file>");
  process.exit(1);
}

const RATING_FLOOR = 3.3;

function valueScore(rating, price) {
  if (!rating || rating <= RATING_FLOOR || !price || price <= 0) return 0;
  return Math.pow(rating - RATING_FLOOR, 2) * 100 / price;
}

function loadDatasetA(minPrice = 8, minReviews = 30) {
  const csvPath = path.join(DATA_DIR, "vivino-dataset-a.csv");
  if (!fs.existsSync(csvPath)) return new Map();
  const rawBytes = fs.readFileSync(csvPath, "latin1");
  const raw = Buffer.from(rawBytes, "latin1").toString("utf8");
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  const map = new Map();
  records.filter(r => parseFloat(r.price) >= minPrice && parseInt(r.num_review) >= minReviews).forEach(r => {
    const k = `${(r.Winery||"").trim()}::${(r.Wine||"").trim()}`;
    if (!map.has(k)) {
      map.set(k, {
        source: "offline-a",
        winery: (r.Winery||"").trim(),
        wineName: (r.Wine||"").trim(),
        rating: parseFloat(r.Rating) || 0,
        reviews: parseInt(r.num_review) || 0,
        price: parseFloat(r.price) || 0,
        country: (r.Country||"").trim(),
        region: (r.Region||"").trim(),
      });
    }
  });
  return map;
}

function loadDatasetB(minReviews = 30) {
  const csvPath = path.join(DATA_DIR, "vivino-dataset-b.csv");
  if (!fs.existsSync(csvPath)) return new Map();
  const raw = fs.readFileSync(csvPath, "utf8");
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  const map = new Map();
  records.filter(r => parseInt((r.NumberOfRatings||"").replace(/[^\d]/g,"")) >= minReviews).forEach(r => {
    const k = `${(r.Winery||"").trim()}::${(r.WineName||"").trim()}`;
    if (!map.has(k)) {
      map.set(k, {
        source: "offline-b",
        winery: (r.Winery||"").trim(),
        wineName: (r.WineName||"").trim(),
        rating: parseFloat(r.Rating) || 0,
        reviews: parseInt((r.NumberOfRatings||"").replace(/[^\d]/g,"")) || 0,
        price: parseFloat(r.Price) || 0,
        country: (r.Country||"").trim(),
        region: "",
      });
    }
  });
  return map;
}

function normStr(s) {
  return String(s).toLowerCase()
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\s+/g, " ").trim();
}

// Returns true if ALL significant words from winery appear in VMP name
// This prevents "Marques de Tomares" matching "Marqués de Murrieta" (shared "Marques")
function wineryInVMP(winery, vmpName) {
  const wineryWords = normStr(winery).split(" ").filter(w => w.length > 3);
  if (!wineryWords.length) return false;
  const vmpNorm = normStr(vmpName);
  return wineryWords.every(w => vmpNorm.includes(w));
}

// Parse output line: "[N/798] Winery WineName... ✓ VMP Name @ PRICE NOK"
function parseOutputFile(filePath) {
  const lines = fs.readFileSync(filePath, "utf8").split("\n");
  const matches = [];
  // Match: "[N/798] <source line>... ✓ <VMP Name> @ <price> NOK"
  const re = /^\[(\d+)\/\d+\] (.+)\.\.\. ✓ (.+) @ ([\d.]+) NOK$/;
  for (const line of lines) {
    const m = line.trim().match(re);
    if (m) {
      matches.push({
        index: parseInt(m[1]),
        sourceLine: m[2].trim(),       // "Winery WineName year"
        vmpName: m[3].trim(),
        vmpPrice75: parseFloat(m[4]),
      });
    }
  }
  return matches;
}

// Reconstruct which wine was at position N in the search order
function buildSearchOrder(datasetA, datasetB, topN = 100, minPriceA = 8) {
  const scoreAndSort = (wines) =>
    wines.map(w => ({ ...w, vivinoScore: valueScore(w.rating, w.price) }))
      .filter(w => w.vivinoScore > 0)
      .sort((x, y) => y.vivinoScore - x.vivinoScore);

  const dedup = (map) => {
    const seen = new Map();
    for (const [k, v] of map) {
      const dk = `${v.source}::${v.winery}::${v.wineName}`;
      if (!seen.has(dk)) seen.set(dk, v);
    }
    return [...seen.values()];
  };

  const topA = scoreAndSort(dedup(datasetA)).slice(0, Math.floor(topN / 2));
  const topB = scoreAndSort(dedup(datasetB));
  return [...topA, ...topB];
}

(async () => {
  const parsedMatches = parseOutputFile(OUTPUT_FILE);
  console.log(`Parsed ${parsedMatches.length} matches from output file`);

  const datasetA = loadDatasetA(8, 30);
  const datasetB = loadDatasetB(30);
  const searchOrder = buildSearchOrder(datasetA, datasetB);
  console.log(`Reconstructed search order: ${searchOrder.length} wines`);

  // Cross-reference: match index → Vivino wine data
  const wines = [];
  for (const m of parsedMatches) {
    const wine = searchOrder[m.index - 1]; // 1-indexed
    if (!wine) {
      console.warn(`No wine at index ${m.index}`);
      continue;
    }

    const finalScore = valueScore(wine.rating, m.vmpPrice75);
    const vivinoScore = valueScore(wine.rating, wine.price);

    // Filter false positives: winery name must appear in VMP wine name
    if (!wineryInVMP(wine.winery, m.vmpName)) {
      // console.log(`FILTERED: "${wine.winery}" not in "${m.vmpName}"`);
      continue;
    }

    wines.push({
      source: wine.source,
      vmpCode: "",
      wine_name: m.vmpName,
      winery: wine.winery,
      country: wine.country,
      region: wine.region,
      vmpPrice75: m.vmpPrice75,
      vmpUrl: "",
      vmpImage: "",
      vivinoRating: wine.rating,
      vivinoReviews: wine.reviews,
      vivinoPrice: wine.price,
      vivinoScore: Number(vivinoScore.toFixed(3)),
      finalScore: Number(finalScore.toFixed(3)),
      matchScore: 0,
      sourceLine: m.sourceLine,
    });
  }

  // Deduplicate by VMP name: keep highest vivinoRating match for each VMP wine
  const byVmpName = new Map();
  wines.forEach(w => {
    const key = normStr(w.wine_name);
    if (!byVmpName.has(key) || w.vivinoRating > byVmpName.get(key).vivinoRating) {
      byVmpName.set(key, w);
    }
  });
  const deduped = [...byVmpName.values()];

  // Sort by final score (using VMP price)
  deduped.sort((a, b) => b.finalScore - a.finalScore);

  const outFile = path.join(DATA_DIR, "vivino-top-matched.json");
  writeJson(outFile, {
    generatedAt: new Date().toISOString(),
    searched: searchOrder.length,
    matched: deduped.length,
    wines: deduped,
  });

  console.log(`\nWrote ${deduped.length} matches (deduped from ${wines.length}) to ${outFile}`);
  console.log("\nTop 20 by Norwegian value score:");
  deduped.slice(0, 20).forEach((w, i) =>
    console.log(`  ${i + 1}. ${w.wine_name} @ ${w.vmpPrice75} NOK — Vivino ${w.vivinoRating}★ (${w.vivinoReviews}r) — score ${w.finalScore}`)
  );
})();
