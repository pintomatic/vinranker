const path = require("path");
const { CATEGORIES, DATA_DIR, fetchJson, readJson, sleep, writeJson } = require("./common");

const STORO = { code: "161", name: "Oslo, Storo" };
const OSLO_STORE_CODES = ["101", "102", "104", "105", "106", "107", "108", "110", "111", "112", "113", "114", "115", "116", "117", "118", "120", "122", "127", "128", "131", "133", "134", "135", "136", "137", "138", "139", "140", "141", "142", "143", "161"];
const PAGE_SIZE = 100;
const MIN_STORO_CONFIRMED = Number(process.env.MIN_STORO_CONFIRMED || 50);

async function fetchStoreCodes(storeCode) {
  const codes = new Set();
  for (const category of CATEGORIES) {
    let page = 0;
    let totalPages = 1;
    while (page < totalPages) {
      const query = `${category.query}:relevance:mainCategory:${category.code}:availableInStores:${storeCode}`;
      const url = `https://www.vinmonopolet.no/vmpws/v2/vmp/products/search?fields=FULL&pageSize=${PAGE_SIZE}&currentPage=${page}&q=${encodeURIComponent(query)}&searchType=product`;
      const data = await fetchJson(url);
      totalPages = data.pagination?.totalPages || 1;
      for (const product of data.products || []) codes.add(product.code);
      page += 1;
      await sleep(900);
    }
  }
  return codes;
}

(async () => {
  const wineData = readJson(path.join(DATA_DIR, "wine-data.json"), null);
  const productData = readJson(path.join(DATA_DIR, "products.json"), { products: [] });
  const top = (wineData?.rated?.length ? wineData.rated : productData.products)
    .slice()
    .sort((a, b) => (b.score || 0) - (a.score || 0))
    .slice(0, 200);

  const storoCodes = await fetchStoreCodes(STORO.code);
  const stock = {};
  for (const wine of top) {
    stock[wine.varenummer] = storoCodes.has(wine.varenummer)
      ? { status: "in_stock", store: STORO.name, storeCode: STORO.code }
      : { status: "not_found", store: STORO.name, storeCode: STORO.code };
  }

  const storoConfirmed = Object.values(stock).filter((entry) => entry.status === "in_stock").length;
  let fallback = null;
  if (storoConfirmed < MIN_STORO_CONFIRMED) {
    const osloCodes = new Set(storoCodes);
    for (const code of OSLO_STORE_CODES.filter((code) => code !== STORO.code)) {
      for (const productCode of await fetchStoreCodes(code)) osloCodes.add(productCode);
    }
    for (const wine of top) {
      if (stock[wine.varenummer]?.status !== "in_stock" && osloCodes.has(wine.varenummer)) {
        stock[wine.varenummer] = { status: "oslo_stock", store: "Oslo fallback", storeCode: "oslo" };
      }
    }
    fallback = "Storo confirmed fewer than 50 top wines; Oslo fallback was added.";
  }

  const output = {
    timestamp: new Date().toISOString(),
    primaryStore: STORO,
    topChecked: top.length,
    storoConfirmed,
    fallback,
    stock,
  };
  writeJson(path.join(DATA_DIR, "stock.json"), output);
  console.log(JSON.stringify({ topChecked: output.topChecked, storoConfirmed, fallback }, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
