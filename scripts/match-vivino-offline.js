/**
 * match-vivino-offline.js
 *
 * Offline Vivino matcher — no browser, no network calls.
 * Matches Vinmonopolet products against Kaggle Vivino datasets using
 * trigram pre-filtering and Jaro-Winkler scoring.
 *
 * Usage:
 *   node scripts/match-vivino-offline.js          # skip already-matched entries
 *   node scripts/match-vivino-offline.js --force  # re-run all entries
 *   USE_OFFLINE_RATINGS=true bash run-all.sh
 *
 * Datasets (download manually from Kaggle — not committed):
 *   data/vivino-dataset-a.csv  (Source A, ~130K wines)
 *   data/vivino-dataset-b.csv  (Source B, ~8K red wines)
 */

const fs = require("fs");
const path = require("path");
const { parse } = require("csv-parse/sync");
const { DATA_DIR, jaroWinkler, readJson, writeJson } = require("./common");

// ── Config ────────────────────────────────────────────────────────────────────

const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const CACHE_FILE = path.join(DATA_DIR, "ratings-cache.json");
const DATASET_A = path.join(DATA_DIR, "vivino-dataset-a.csv");
const DATASET_B = path.join(DATA_DIR, "vivino-dataset-b.csv");

const THRESHOLD = 0.75;
const MIN_RATINGS = 10;
const MAX_CANDIDATES = 500;
const SAVE_EVERY = 10;
const FORCE = process.argv.includes("--force");

// ── Normalization ─────────────────────────────────────────────────────────────

const NO_COUNTRIES = /\b(spania|frankrike|italia|portugal|australia|tyskland|sør-afrika|usa|chile|argentina|new zealand|østerrike|ungarn|sveits|hellas|georgia|libanon|israel|kroatia|bulgaria|romania|moldov|tsjekkia|slovenia|serbia)\b/gi;
const EN_COUNTRIES = /\b(spain|france|italy|germany|australia|south africa|chile|argentina|austria|hungary|switzerland|greece|lebanon|israel|croatia|bulgaria|romania|moldova|slovakia|slovenia|serbia|portugal|new zealand)\b/gi;

/**
 * Normalize a wine name for matching.
 *
 * - isVinmonopolet=true: strips Norwegian country names, keeps æøå
 * - isVinmonopolet=false: strips English country names, removes diacritics
 */
function normalizeWineName(name, isVinmonopolet = false) {
  let s = String(name || "").toLowerCase();

  // NFD decompose + strip combining diacritics on BOTH sides so trigrams align.
  // æøå do not decompose in NFD so they survive this step unchanged.
  // Explicit unicode range [̀-ͯ] — not literal chars which are encoding-fragile.
  s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");

  // Strip all vintages (global flag — handles multiple years in one name)
  s = s.replace(/\b(19|20)\d{2}\b/g, "");
  // Strip volumes
  s = s.replace(/\b\d+([,.]\d+)?\s?(cl|l|ml)\b/g, "");

  if (isVinmonopolet) {
    s = s.replace(NO_COUNTRIES, "");
    // Keep æøå through the character filter (they survived NFD above)
    s = s.replace(/[^a-z0-9æøåÆØÅ\s]/g, " ");
  } else {
    s = s.replace(EN_COUNTRIES, "");
    s = s.replace(/[^a-z0-9\s]/g, " ");
  }

  return s.replace(/\s+/g, " ").trim();
}

// ── CSV Loading ───────────────────────────────────────────────────────────────

/**
 * Print first 3 rows of a CSV so we can verify column headers.
 */
function peekCsvHeaders(csvText, label) {
  const lines = csvText.split("\n").slice(0, 3).filter(Boolean);
  console.log(`\n${label} — first 3 rows:`);
  lines.forEach((l, i) => console.log(`  [${i}] ${l.substring(0, 120)}`));
}

/**
 * Load Source A (primary dataset, ~130K wines).
 * Expected columns: wine_name, winery, rating, num_reviews, country, region
 */
function loadDatasetA(csvPath) {
  // Read as latin1 then re-encode — handles double-encoded UTF-8 (e.g. "EspaÃ±a" → "España")
  const rawBytes = fs.readFileSync(csvPath, "latin1");
  const raw = Buffer.from(rawBytes, "latin1").toString("utf8");
  peekCsvHeaders(raw, "Source A");

  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`  → ${rows.length} rows parsed`);

  return rows.map((r) => ({
    // Handle capitalized column names from this dataset: Wine, Winery, Rating, etc.
    wine_name: r.Wine || r.wine_name || r.name || "",
    winery: r.Winery || r.winery || "",
    rating: parseFloat(r.Rating || r.rating) || null,
    ratings_count: parseInt(r.num_review || r.num_reviews || r.ratings_count || r.num_ratings || "0", 10) || 0,
    country: r.Country || r.country || "",
    region: r.Region || r.region || "",
    source: "offline-a",
  })).filter((w) => w.wine_name && w.rating);
}

/**
 * Load Source B (global Vivino wines from boivinalex/vivino-recommenderpy).
 * Columns: ,WineName,Winery,Country,Rating,NumberOfRatings,Price
 * NumberOfRatings has " ratings" suffix (e.g. "492 ratings")
 */
function loadDatasetB(csvPath) {
  const raw = fs.readFileSync(csvPath, "utf8");
  peekCsvHeaders(raw, "Source B");

  const rows = parse(raw, { columns: true, skip_empty_lines: true, trim: true });
  console.log(`  → ${rows.length} rows parsed`);

  return rows.map((r) => ({
    wine_name: r.WineName || r.name || r.wine_name || "",
    winery: r.Winery || r.winery || "",
    rating: parseFloat(r.Rating || r.rating) || null,
    // NumberOfRatings may have " ratings" suffix — strip non-numeric chars
    ratings_count: parseInt((r.NumberOfRatings || r.num_ratings || r.num_reviews || "0").replace(/[^\d]/g, ""), 10) || 0,
    country: r.Country || r.country || "",
    region: r.Region || r.region || "",
    source: "offline-b",
  })).filter((w) => w.wine_name && w.rating);
}

/**
 * Merge datasets A and B, deduplicating on winery_wine key.
 * Source A wins on collision.
 */
function mergeDatasets(sourceA, sourceB) {
  const map = new Map();

  // Load Source B first so A can overwrite on collision
  for (const w of sourceB) {
    const key = `${normalizeWineName(w.winery)}_${normalizeWineName(w.wine_name)}`;
    if (key) map.set(key, w);
  }
  for (const w of sourceA) {
    const key = `${normalizeWineName(w.winery)}_${normalizeWineName(w.wine_name)}`;
    if (key) map.set(key, w);
  }

  return Array.from(map.values());
}

// ── Trigram Index ─────────────────────────────────────────────────────────────

function trigrams(s) {
  const out = [];
  for (let i = 0; i < s.length - 2; i++) {
    out.push(s.slice(i, i + 3));
  }
  return out;
}

/**
 * Build a trigram index: gram → Set of wine indices.
 */
function buildTrigramIndex(wines) {
  const index = new Map();
  for (let i = 0; i < wines.length; i++) {
    const key = `${normalizeWineName(wines[i].winery)} ${normalizeWineName(wines[i].wine_name)}`;
    for (const gram of trigrams(key)) {
      if (!index.has(gram)) index.set(gram, new Set());
      index.get(gram).add(i);
    }
  }
  return index;
}

/**
 * Get top-N candidate wine indices by trigram overlap count.
 */
function getCandidates(query, index, max = MAX_CANDIDATES) {
  const counts = new Map();
  for (const gram of trigrams(query)) {
    const hits = index.get(gram);
    if (!hits) continue;
    for (const idx of hits) {
      counts.set(idx, (counts.get(idx) || 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([idx]) => idx);
}

// ── Country helpers ───────────────────────────────────────────────────────────

// Map Norwegian country names → English for comparison against dataset
const NO_TO_EN = {
  spania: "spain",
  frankrike: "france",
  italia: "italy",
  portugal: "portugal",
  australia: "australia",
  tyskland: "germany",
  "sør-afrika": "south africa",
  usa: "usa",
  chile: "chile",
  argentina: "argentina",
  "new zealand": "new zealand",
  østerrike: "austria",
  ungarn: "hungary",
  sveits: "switzerland",
  hellas: "greece",
  georgia: "georgia",
  libanon: "lebanon",
  israel: "israel",
  kroatia: "croatia",
  bulgaria: "bulgaria",
  romania: "romania",
  moldov: "moldova",
  tsjekkia: "czech republic",
  slovenia: "slovenia",
  serbia: "serbia",
};

function productCountryEn(product) {
  const raw = (product.country || "").toLowerCase().trim();
  return NO_TO_EN[raw] || raw;
}

// ── Matching ──────────────────────────────────────────────────────────────────

/**
 * Find the best Vivino match for a Vinmonopolet product.
 * Returns a cache entry object.
 */
function findMatch(product, wines, index) {
  const query = normalizeWineName(product.name, true);

  if (!query) {
    return {
      varenummer: product.varenummer,
      status: "unmatched",
      fetchedAt: new Date().toISOString(),
      query,
      candidateCount: 0,
    };
  }

  const candidateIndices = getCandidates(query, index);

  // Score each candidate
  const scored = candidateIndices
    .map((idx) => {
      const w = wines[idx];
      const candidateStr = `${normalizeWineName(w.winery)} ${normalizeWineName(w.wine_name)}`;
      const score = jaroWinkler(query, candidateStr);
      return { wine: w, score };
    })
    // Hard filter: must have minimum rating confidence
    .filter((c) => c.wine.ratings_count >= MIN_RATINGS)
    .sort((a, b) => {
      // Primary: score descending
      if (Math.abs(a.score - b.score) > 0.02) return b.score - a.score;
      // Tie-breaker 1: higher ratings_count
      if (a.wine.ratings_count !== b.wine.ratings_count) {
        return b.wine.ratings_count - a.wine.ratings_count;
      }
      // Tie-breaker 2: country match
      const productCountry = productCountryEn(product);
      const aMatch = a.wine.country.toLowerCase() === productCountry ? 1 : 0;
      const bMatch = b.wine.country.toLowerCase() === productCountry ? 1 : 0;
      return bMatch - aMatch;
    });

  const best = scored[0];

  if (!best || best.score < THRESHOLD) {
    return {
      varenummer: product.varenummer,
      status: "unmatched",
      fetchedAt: new Date().toISOString(),
      query,
      candidateCount: candidateIndices.length,
    };
  }

  return {
    varenummer: product.varenummer,
    status: "matched",
    fetchedAt: new Date().toISOString(),
    query,
    rating: best.wine.rating,
    ratingsCount: best.wine.ratings_count,
    vivinoName: `${best.wine.winery} ${best.wine.wine_name}`.trim(),
    matchScore: Number(best.score.toFixed(3)),
    vivinoRegion: best.wine.region || "",
    source: best.wine.source,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  // ── 1. Check for --help ───────────────────────────────────────────────────
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log("Usage: node scripts/match-vivino-offline.js [--force]");
    console.log("  --force   re-run all products, ignoring existing cache");
    console.log("\nDatasets required (download from Kaggle, place in data/):");
    console.log("  data/vivino-dataset-a.csv  (joshuakalobbowles/vivino-wine-data, ~130K wines)");
    console.log("  data/vivino-dataset-b.csv  (nikitatkachenko/vivinoredwine, ~8K wines)");
    process.exit(0);
  }

  console.log(`match-vivino-offline — force=${FORCE}`);

  // ── 2. Load products ──────────────────────────────────────────────────────
  const productData = readJson(PRODUCTS_FILE);
  if (!productData?.products?.length) {
    throw new Error("data/products.json missing or empty — run scrape-vinmonopolet.js first");
  }
  const products = productData.products;
  console.log(`\nProducts: ${products.length}`);

  // ── 3. Load datasets ──────────────────────────────────────────────────────
  const haveA = fs.existsSync(DATASET_A);
  const haveB = fs.existsSync(DATASET_B);

  if (!haveA && !haveB) {
    console.error("\nERROR: No Vivino datasets found.\n");
    console.error("Download from Kaggle (free account required):\n");
    console.error("  Source A (~130K wines, primary):");
    console.error("    pip install kaggle");
    console.error(`    kaggle datasets download -d joshuakalobbowles/vivino-wine-data -p data/`);
    console.error(`    # Rename the CSV to: data/vivino-dataset-a.csv\n`);
    console.error("  Source B (~8K red wines, supplement):");
    console.error(`    kaggle datasets download -d nikitatkachenko/vivinoredwine -p data/`);
    console.error(`    # Rename the CSV to: data/vivino-dataset-b.csv\n`);
    console.error("Or download manually at:");
    console.error("  https://www.kaggle.com/datasets/joshuakalobbowles/vivino-wine-data");
    console.error("  https://www.kaggle.com/datasets/nikitatkachenko/vivinoredwine");
    process.exit(1);
  }

  let sourceA = [];
  let sourceB = [];

  if (haveA) {
    console.log("\nLoading Source A...");
    sourceA = loadDatasetA(DATASET_A);
    console.log(`  Source A: ${sourceA.length} wines after filter`);
  } else {
    console.warn("\nWARN: data/vivino-dataset-a.csv not found — using Source B only");
  }

  if (haveB) {
    console.log("\nLoading Source B...");
    sourceB = loadDatasetB(DATASET_B);
    console.log(`  Source B: ${sourceB.length} wines after filter`);
  } else {
    console.warn("\nWARN: data/vivino-dataset-b.csv not found — using Source A only");
  }

  // ── 4. Merge and deduplicate ──────────────────────────────────────────────
  console.log("\nMerging and deduplicating...");
  const wines = mergeDatasets(sourceA, sourceB);
  console.log(`  Merged dataset: ${wines.length} unique wines`);

  // ── 5. Build trigram index ────────────────────────────────────────────────
  console.log("\nBuilding trigram index...");
  const t0 = Date.now();
  const index = buildTrigramIndex(wines);
  console.log(`  Index built in ${Date.now() - t0}ms (${index.size} unique trigrams)`);

  // ── 6. Load cache ─────────────────────────────────────────────────────────
  const cache = readJson(CACHE_FILE, {});
  const initialMatchCount = Object.values(cache).filter((e) => e.status === "matched").length;
  console.log(`\nCache: ${Object.keys(cache).length} entries (${initialMatchCount} matched)`);

  // ── 7. Match products ─────────────────────────────────────────────────────
  console.log(`\nMatching ${products.length} products (threshold=${THRESHOLD}, minRatings=${MIN_RATINGS})...\n`);

  let processed = 0;
  let newMatches = 0;
  let newUnmatched = 0;

  for (const product of products) {
    const existing = cache[product.varenummer];

    // Skip logic: in default mode, skip anything already matched
    if (!FORCE && existing?.status === "matched") {
      continue;
    }

    const result = findMatch(product, wines, index);
    cache[product.varenummer] = result;
    processed++;

    if (result.status === "matched") {
      newMatches++;
      console.log(`  matched  ${product.varenummer}: ${result.vivinoName} (score=${result.matchScore}, ratings=${result.ratingsCount})`);
    } else {
      newUnmatched++;
      console.log(`  unmatched ${product.varenummer}: ${product.name} (candidates=${result.candidateCount})`);
    }

    // Flush cache every N products
    if (processed % SAVE_EVERY === 0) {
      writeJson(CACHE_FILE, cache);
    }
  }

  // Final flush
  writeJson(CACHE_FILE, cache);

  // ── 8. Stats ──────────────────────────────────────────────────────────────
  const allEntries = Object.values(cache);
  const totalMatched = allEntries.filter((e) => e.status === "matched").length;
  const totalUnmatched = allEntries.filter((e) => e.status !== "matched").length;
  const matchRate = ((totalMatched / allEntries.length) * 100).toFixed(1);

  console.log("\n── Results ──────────────────────────────────────────────────────");
  console.log(`  Processed this run : ${processed}`);
  console.log(`  New matches        : ${newMatches}`);
  console.log(`  New unmatched      : ${newUnmatched}`);
  console.log("  ────────────────────────────────────────────────────────────");
  console.log(`  Total in cache     : ${allEntries.length}`);
  console.log(`  Total matched      : ${totalMatched}`);
  console.log(`  Total unmatched    : ${totalUnmatched}`);
  console.log(`  Match rate         : ${matchRate}%`);
  console.log("");
})().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
