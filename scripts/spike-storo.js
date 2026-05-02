const path = require("path");
const { DATA_DIR, fetchJson, writeJson } = require("./common");

const PRODUCT = "18672501";
const STORO_STORE = "161";

(async () => {
  const availabilityUrl = `https://www.vinmonopolet.no/vmpws/v3/vmp/products/${PRODUCT}/availability`;
  const stockUrl = `https://www.vinmonopolet.no/vmpws/v2/vmp/products/search?fields=FULL&pageSize=5&currentPage=0&q=:relevance:availableInStores:${STORO_STORE}&searchType=product`;

  const availability = await fetchJson(availabilityUrl);
  const storoSearch = await fetchJson(stockUrl);

  const result = {
    ranAt: new Date().toISOString(),
    pass: true,
    productAvailability: {
      url: availabilityUrl,
      auth: "none",
      responseShape: Object.keys(availability),
      sample: availability,
    },
    storoAssortment: {
      url: stockUrl,
      auth: "none",
      resultCount: storoSearch.pagination?.totalNumberOfResults ?? storoSearch.products?.length ?? 0,
      sampleCodes: (storoSearch.products || []).map((product) => product.code),
    },
  };

  writeJson(path.join(DATA_DIR, "spike-storo.json"), result);
  console.log(JSON.stringify(result, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
