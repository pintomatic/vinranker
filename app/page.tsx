import WineRanker, { type WineData } from "./wine-ranker";

export const revalidate = 86400;

const DATA_URL =
  process.env.WINE_DATA_URL ||
  "https://storage.googleapis.com/studio-1718008502-e95e8.appspot.com/wine/wine-data.json";

const fallbackData: WineData = {
  timestamp: new Date().toISOString(),
  sourceTimestamps: { products: null, stock: null, ratingsFetchedFrom: "fallback" },
  config: { ratingFloor: 3.5, scoreExponent: 2 },
  stats: { total: 3, rated: 2, unrated: 1, matchRate: 0.667, top10Under200: 1 },
  warnings: ["Live wine-data.json is not available yet. Run scripts/run-all.sh and upload to Firebase Storage."],
  rated: [
    {
      varenummer: "5324901",
      name: "Ch. du Cedre Cahors 2022",
      category: "Rodvin",
      country: "Frankrike",
      district: "Cahors",
      alcohol: 13.5,
      volumeCl: 75,
      price: 281.2,
      price75: 281.2,
      url: "https://www.vinmonopolet.no/",
      image: "",
      vivinoRating: 4.1,
      vivinoRatingsCount: 1200,
      vivinoName: "Chateau du Cedre Cahors",
      matchScore: 0.91,
      score: 0.128,
      stockStatus: "unchecked",
      stockStore: null,
    },
    {
      varenummer: "9186801",
      name: "Rabl Zweigelt Rose 2025",
      category: "Rosevin",
      country: "Osterrike",
      district: "",
      alcohol: 12,
      volumeCl: 75,
      price: 159.9,
      price75: 159.9,
      url: "https://www.vinmonopolet.no/",
      image: "",
      vivinoRating: 3.8,
      vivinoRatingsCount: 320,
      vivinoName: "Rabl Zweigelt Rose",
      matchScore: 0.89,
      score: 0.056,
      stockStatus: "in_stock",
      stockStore: "Oslo, Storo",
    },
  ],
  unrated: [
    {
      varenummer: "18672501",
      name: "Trondelag rodvin",
      category: "Rodvin",
      country: "Frankrike",
      district: "Perigord",
      alcohol: 13.5,
      volumeCl: 75,
      price: 175,
      price75: 175,
      url: "https://www.vinmonopolet.no/",
      image: "",
      vivinoRating: null,
      vivinoRatingsCount: null,
      vivinoName: null,
      matchScore: null,
      score: 0,
      stockStatus: "not_found",
      stockStore: "Oslo, Storo",
    },
  ],
};

async function getWineData(): Promise<WineData> {
  if (process.env.NODE_ENV === "development" && !process.env.WINE_DATA_URL) {
    return fallbackData;
  }
  try {
    const response = await fetch(DATA_URL, {
      next: { revalidate },
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } catch {
    return fallbackData;
  }
}

export default async function Home() {
  const data = await getWineData();
  return <WineRanker data={data} dataUrl={DATA_URL} />;
}
