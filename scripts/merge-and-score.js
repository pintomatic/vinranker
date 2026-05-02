const path = require("path");
const { DATA_DIR, readJson, writeJson } = require("./common");

const FLOOR = Number(process.env.RATING_FLOOR || 3.5);
const EXPONENT = Number(process.env.SCORE_EXPONENT || 2);

function scoreWine(rating, price75) {
  if (!rating || rating < FLOOR || !price75) return 0;
  return Number(((Math.pow(rating - FLOOR, EXPONENT) * 100) / price75).toFixed(3));
}

(async () => {
  const productData = readJson(path.join(DATA_DIR, "products.json"));
  const ratings = readJson(path.join(DATA_DIR, "ratings-cache.json"), {});
  const stockData = readJson(path.join(DATA_DIR, "stock.json"), { stock: {}, timestamp: null, fallback: null });
  if (!productData?.products?.length) throw new Error("Run scrape-vinmonopolet.js first.");

  const wines = productData.products.map((product) => {
    const rating = ratings[product.varenummer];
    const stock = stockData.stock?.[product.varenummer] || null;
    return {
      ...product,
      vivinoRating: rating?.status === "matched" ? rating.rating : null,
      vivinoRatingsCount: rating?.status === "matched" ? rating.ratingsCount : null,
      vivinoName: rating?.vivinoName || null,
      matchScore: rating?.matchScore || null,
      score: scoreWine(rating?.rating, product.price75),
      stockStatus: stock?.status || "unchecked",
      stockStore: stock?.store || null,
    };
  });

  const rated = wines.filter((wine) => wine.vivinoRating >= FLOOR).sort((a, b) => b.score - a.score);
  const unrated = wines.filter((wine) => !wine.vivinoRating || wine.vivinoRating < FLOOR).sort((a, b) => a.price75 - b.price75);
  const topUnder200 = rated.slice(0, 10).filter((wine) => wine.price75 < 200).length;
  const matchRate = wines.length ? rated.length / wines.length : 0;
  const warnings = [];
  if (topUnder200 < 3) warnings.push(`Top 10 includes ${topUnder200} wines under 200 NOK; consider SCORE_EXPONENT=1.75 then 1.5.`);
  if (rated.length < 200) warnings.push(`Rated tab has ${rated.length} wines; consider RATING_FLOOR=3.3 for v1.`);
  if (stockData.fallback) warnings.push(stockData.fallback);

  const output = {
    timestamp: new Date().toISOString(),
    sourceTimestamps: {
      products: productData.timestamp,
      stock: stockData.timestamp,
      ratingsFetchedFrom: "ratings-cache.json",
    },
    config: { ratingFloor: FLOOR, scoreExponent: EXPONENT },
    stats: {
      total: wines.length,
      rated: rated.length,
      unrated: unrated.length,
      matchRate: Number(matchRate.toFixed(3)),
      top10Under200: topUnder200,
    },
    warnings,
    rated,
    unrated,
  };

  writeJson(path.join(DATA_DIR, "wine-data.json"), output);
  console.log(JSON.stringify(output.stats, null, 2));
  if (warnings.length) console.warn(warnings.join("\n"));
})();
