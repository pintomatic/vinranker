import WineRanker, { type WineData } from "./wine-ranker";
import wineData from "../data/wine-data.json";

export default async function Home() {
  return <WineRanker data={wineData as WineData} dataUrl={null} />;
}
