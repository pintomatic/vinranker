const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const CATEGORIES = [
  { slug: "red", label: "Rodvin", query: "rødvin", code: "rødvin" },
  { slug: "white", label: "Hvitvin", query: "hvitvin", code: "hvitvin" },
  { slug: "rose", label: "Rosevin", query: "rosévin", code: "rosévin" },
  { slug: "sparkling", label: "Musserende", query: "musserende vin", code: "musserende_vin" },
];

function ensureDir(dir = DATA_DIR) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fallback = null) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function isFresh(file, maxAgeHours = 24) {
  if (!fs.existsSync(file)) return false;
  const age = Date.now() - fs.statSync(file).mtimeMs;
  return age < maxAgeHours * 60 * 60 * 1000;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const retries = options.retries ?? 4;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const response = await fetch(url, {
      ...options,
      headers: {
        accept: "application/json",
        "user-agent": "vinranker/0.1 monthly wine index",
        ...(options.headers || {}),
      },
    });
    if (response.ok) return response.json();
    if ((response.status === 429 || response.status >= 500) && attempt < retries) {
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const wait = retryAfter ? retryAfter * 1000 : 1500 * (attempt + 1) ** 2;
      await sleep(wait);
      continue;
    }
    throw new Error(`${response.status} ${response.statusText}: ${url}`);
  }
}

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\b(19|20)\d{2}\b/g, "")
    .replace(/\b\d+([,.]\d+)?\s?(cl|l|ml)\b/g, "")
    .replace(/[^a-z0-9æøå]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function levenshtein(a, b) {
  const matrix = Array.from({ length: b.length + 1 }, (_, i) => [i]);
  for (let j = 0; j <= a.length; j += 1) matrix[0][j] = j;
  for (let i = 1; i <= b.length; i += 1) {
    for (let j = 1; j <= a.length; j += 1) {
      matrix[i][j] =
        b.charAt(i - 1) === a.charAt(j - 1)
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[b.length][a.length];
}

function jaroWinkler(a, b) {
  const s1 = normalizeText(a);
  const s2 = normalizeText(b);
  if (!s1 || !s2) return 0;
  const max = Math.max(s1.length, s2.length);
  const ratio = 1 - levenshtein(s1, s2) / max;
  let prefix = 0;
  while (prefix < Math.min(4, s1.length, s2.length) && s1[prefix] === s2[prefix]) prefix += 1;
  return Math.min(1, ratio + prefix * 0.1 * (1 - ratio));
}

function normalizeProduct(product, categoryLabel) {
  const volumeCl = Number(product.volume?.value || 75);
  const price = Number(product.price?.value || 0);
  const price75 = volumeCl ? price / (volumeCl / 75) : price;
  return {
    varenummer: product.code,
    name: product.name,
    category: product.main_category?.name || categoryLabel,
    country: product.main_country?.name || "",
    district: product.district?.name || "",
    alcohol: product.alcohol?.value ?? null,
    volumeCl,
    price,
    price75: Number(price75.toFixed(2)),
    url: product.url ? `https://www.vinmonopolet.no${product.url}` : "",
    image: product.images?.find((image) => image.format === "product")?.url || product.images?.[0]?.url || "",
  };
}

module.exports = {
  ROOT,
  DATA_DIR,
  CATEGORIES,
  ensureDir,
  readJson,
  writeJson,
  isFresh,
  sleep,
  fetchJson,
  normalizeText,
  jaroWinkler,
  normalizeProduct,
};
