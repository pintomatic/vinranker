const path = require("path");
const { chromium } = require("playwright");
const { DATA_DIR, jaroWinkler, normalizeText, readJson, sleep, writeJson } = require("./common");

const CACHE_FILE = path.join(DATA_DIR, "ratings-cache.json");
const PRODUCTS_FILE = path.join(DATA_DIR, "products.json");
const MAX_AGE_MS = 31 * 24 * 60 * 60 * 1000;
const THRESHOLD = Number(process.env.MATCH_THRESHOLD || 0.85);
const LIMIT = Number(process.env.VIVINO_LIMIT || 0);

function isCacheFresh(entry) {
  return entry?.fetchedAt && Date.now() - Date.parse(entry.fetchedAt) < MAX_AGE_MS;
}

function parseCandidates(text) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const candidates = [];
  for (let i = 0; i < lines.length; i += 1) {
    const rating = Number(lines[i]);
    const next = lines[i + 1] || "";
    if (rating >= 3 && rating <= 5 && /^\([\d,.]+\s+ratings?\)$/i.test(next)) {
      candidates.push({
        title: [lines[i - 3], lines[i - 2]].filter(Boolean).join(" "),
        winery: lines[i - 3] || "",
        wine: lines[i - 2] || "",
        region: lines[i - 1] || "",
        rating,
        ratingsCount: Number(next.replace(/[^\d]/g, "")) || null,
      });
    }
  }
  return candidates;
}

async function findVivinoMatch(page, product) {
  const query = `${product.name} ${product.country}`.trim();
  const url = `https://www.vivino.com/search/wines?q=${encodeURIComponent(query)}`;
  const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(1000);
  const text = await page.locator("body").innerText({ timeout: 7000 }).catch(() => "");
  const candidates = parseCandidates(text);
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      matchScore: Math.max(
        jaroWinkler(product.name, candidate.title),
        jaroWinkler(product.name, candidate.wine),
        jaroWinkler(`${product.name} ${product.country}`, `${candidate.title} ${candidate.region}`),
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
      httpStatus: response?.status() || 0,
      bestCandidate: best || null,
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

  for (const product of products) {
    if (isCacheFresh(cache[product.varenummer])) {
      console.log(`skip ${product.varenummer}: fresh cache`);
      continue;
    }
    try {
      cache[product.varenummer] = await findVivinoMatch(page, product);
      console.log(`${product.varenummer}: ${cache[product.varenummer].status}`);
      writeJson(CACHE_FILE, cache);
    } catch (error) {
      cache[product.varenummer] = { varenummer: product.varenummer, status: "error", fetchedAt: new Date().toISOString(), error: error.message };
      writeJson(CACHE_FILE, cache);
      console.error(`${product.varenummer}: ${error.message}`);
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
