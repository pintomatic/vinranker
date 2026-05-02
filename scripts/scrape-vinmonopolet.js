const path = require("path");
const { CATEGORIES, DATA_DIR, fetchJson, isFresh, normalizeProduct, sleep, writeJson, readJson } = require("./common");

const PAGE_SIZE = Number(process.env.PAGE_SIZE || 100);
const MAX_PAGES_PER_CATEGORY = Number(process.env.MAX_PAGES_PER_CATEGORY || 0);

async function scrapeCategory(category) {
  const outFile = path.join(DATA_DIR, `products-${category.slug}.json`);
  if (isFresh(outFile, 24)) {
    console.log(`skip ${category.label}: fresh checkpoint`);
    return readJson(outFile, []);
  }

  const products = [];
  let page = 0;
  let totalPages = 1;
  while (page < totalPages) {
    if (MAX_PAGES_PER_CATEGORY && page >= MAX_PAGES_PER_CATEGORY) break;
    const query = `${category.query}:price-asc:mainCategory:${category.code}`;
    const url = `https://www.vinmonopolet.no/vmpws/v2/vmp/products/search?fields=FULL&pageSize=${PAGE_SIZE}&currentPage=${page}&q=${encodeURIComponent(query)}&searchType=product`;
    const data = await fetchJson(url);
    totalPages = data.pagination?.totalPages || totalPages;
    const pageProducts = (data.products || []).map((product) => normalizeProduct(product, category.label));
    products.push(...pageProducts);
    console.log(`${category.label}: page ${page + 1}/${totalPages}, total ${products.length}`);
    page += 1;
    await sleep(900);
  }

  writeJson(outFile, products);
  return products;
}

(async () => {
  const all = [];
  for (const category of CATEGORIES) {
    all.push(...(await scrapeCategory(category)));
  }
  const deduped = [...new Map(all.map((product) => [product.varenummer, product])).values()];
  writeJson(path.join(DATA_DIR, "products.json"), {
    timestamp: new Date().toISOString(),
    source: "Vinmonopolet public product search",
    count: deduped.length,
    products: deduped,
  });
  console.log(`wrote ${deduped.length} products`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
