const path = require("path");
const { chromium } = require("playwright");
const { DATA_DIR, jaroWinkler, normalizeText, readJson, sleep, writeJson } = require("./common");

const CACHE_FILE = path.join(DATA_DIR, "ratings-cache.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;
const ERROR_TTL_MS = 60 * 60 * 1000; // errors expire in 1h, not 1 month
const CONSECUTIVE_FAIL_LIMIT = 5; // abort if Vivino blocks N in a row
const THRESHOLD = Number(process.env.MATCH_THRESHOLD || 0.75);
const LIMIT = Number(process.env.VIVINO_LIMIT || 0);

// Norwegian country names to strip from search query — Vivino doesn't know "Spania"
const COUNTRY_STRIP = /\b(spania|frankrike|italia|portugal|australia|tyskland|sør-afrika|usa|chile|argentina|new zealand|østerrike|ungarn|sveits|greece|hellas|georgia|libanon|israel|kroatia|bulgaria|romania|moldova|slovakia|tsjekkia|slovenia|serbia)\b/gi;

function buildQuery(product) {
  let name = product.name.toLowerCase();
  // Strip Norwegian country names
  name = name.replace(COUNTRY_STRIP, "").trim();
  // Strip vintage year — Vivino search ignores vintage
  name = name.replace(/\b(19|20)\d{2}\b/g, "").trim();
  // Collapse multiple spaces
  name = name.replace(/\s+/g, " ").trim();
  return name;
}

function isCacheFresh(entry) {
  if (!entry?.fetchedAt) return false;
  const age = Date.now() - Date.parse(entry.fetchedAt);
  // Errors expire quickly so we retry after IP ban lifts
  if (entry.status === "error") return age < ERROR_TTL_MS;
  return age < MAX_AGE_MS;
}

// Extract wine cards from Vivino's internal API JSON response
function parseCandidatesFromJson(wines) {
  if (!Array.isArray(wines)) return [];
  return wines.map((w) => ({
    title: [w.winery?.name, w.name].filter(Boolean).join(" "),
    winery: w.winery?.name || "",
    wine: w.name || "",
    region: w.region?.name || w.region?.country?.name || "",
    rating: w.statistics?.ratings_average || null,
    ratingsCount: w.statistics?.ratings_count || null,
    wineryId: w.winery?.id,
    wineId: w.id,
  })).filter((c) => c.rating && c.rating >= 3);
}

async function findVivinoMatch(page, product) {
  const query = buildQuery(product);
  const searchUrl = `https://www.vivino.com/search/wines?q=${encodeURIComponent(query)}`;

  let apiWines = null;

  // Intercept Vivino's internal API call to get wine data as JSON
  await page.route("**/api/explore/explore**", async (route) => {
    const res = await route.fetch();
    try {
      const json = await res.json();
      apiWines = json?.explore_vintage?.matches?.map((m) => m.vintage?.wine) || [];
    } catch {}
    await route.fulfill({ response: res });
  });

  try {
    let navResponse = null;
    try {
      navResponse = await page.goto(searchUrl, { waitUntil: "networkidle", timeout: 35000 });
    } catch (navErr) {
      throw new Error(`Navigation failed: ${navErr.message}`);
    }
    // null response = redirect chain failure or about:blank — treat as navigation error
    if (!navResponse) throw new Error("Navigation returned null response");
    // Detect Vivino blocking (CloudFront 403) — do NOT swallow as "unmatched"
    if (navResponse.status() === 403 || navResponse.status() === 429) {
      throw new Error(`Vivino blocked (HTTP ${navResponse.status()}) — IP may be rate-limited`);
    }
    await page.waitForTimeout(1000);
  } finally {
    // Always unroute to prevent handler stacking across iterations
    await page.unroute("**/api/explore/explore**").catch(() => null);
  }

  const candidates = parseCandidatesFromJson(apiWines || []);
  const ranked = candidates
    .map((c) => ({
      ...c,
      matchScore: Math.max(
        jaroWinkler(query, c.title.toLowerCase()),
        jaroWinkler(query, c.wine.toLowerCase()),
        jaroWinkler(product.name.toLowerCase(), c.title.toLowerCase()),
      ),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);

  const best = ranked[0];
  if (!best || best.matchScore < THRESHOLD) {
    return {
      varenummer: product.varenummer,
      status: "unmatched",
      fetchedAt: new Date().toISOString(),
      query,
      url: page.url(),
      bestCandidate: best || null,
      candidateCount: candidates.length,
      normalizedName: normalizeText(product.name),
    };
  }
  return {
    varenummer: product.varenummer,
    status: "matched",
    fetchedAt: new Date().toISOString(),
    query,
    url: page.url(),
    rating: best.rating,
    ratingsCount: best.ratingsCount,
    vivinoName: best.title,
    vivinoRegion: best.region,
    matchScore: Number(best.matchScore.toFixed(3)),
  };
}

(async () => {
  const productData = readJson(PRODUCTS_FILE);
  if (!productData?.products?.length) throw new Error("Run scrape-vinmonopolet.js first; data/products.json is missing.");
  const cache = readJson(CACHE_FILE, {});
  const products = LIMIT ? productData.products.slice(0, LIMIT) : productData.products;

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    locale: "en-US",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });
  const page = await context.newPage();

  let consecutiveFails = 0;
  for (const product of products) {
    if (isCacheFresh(cache[product.varenummer])) {
      console.log(`skip ${product.varenummer}: fresh cache`);
      continue;
    }
    try {
      cache[product.varenummer] = await findVivinoMatch(page, product);
      console.log(`${product.varenummer}: ${cache[product.varenummer].status}`);
      writeJson(CACHE_FILE, cache);
      if (cache[product.varenummer].status !== "error") consecutiveFails = 0;
    } catch (error) {
      consecutiveFails += 1;
      cache[product.varenummer] = { varenummer: product.varenummer, status: "error", fetchedAt: new Date().toISOString(), error: error.message };
      writeJson(CACHE_FILE, cache);
      console.error(`${product.varenummer}: ${error.message}`);
      if (consecutiveFails >= CONSECUTIVE_FAIL_LIMIT) {
        console.error(`ABORT: ${CONSECUTIVE_FAIL_LIMIT} consecutive failures — Vivino may be blocking. Re-run after IP ban lifts.`);
        break;
      }
    }
    await sleep(3000);
  }

  await browser.close();
  const entries = Object.values(cache);
  const matched = entries.filter((entry) => entry.status === "matched").length;
  console.log(`matched ${matched}/${entries.length}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
