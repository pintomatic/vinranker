"use client";

import { useMemo, useState } from "react";

export type Wine = {
  varenummer: string;
  name: string;
  category: string;
  country: string;
  district: string;
  alcohol: number | null;
  volumeCl: number;
  price: number;
  price75: number;
  url: string;
  image: string;
  vivinoRating: number | null;
  vivinoRatingsCount: number | null;
  vivinoName: string | null;
  matchScore: number | null;
  score: number;
  stockStatus: string;
  stockStore: string | null;
};

export type WineData = {
  timestamp: string;
  sourceTimestamps: { products: string | null; stock: string | null; ratingsFetchedFrom: string };
  config: { ratingFloor: number; scoreExponent: number };
  stats: { total: number; rated: number; unrated: number; matchRate: number; top10Under200: number };
  warnings: string[];
  rated: Wine[];
  unrated: Wine[];
};

const categoryOrder = ["All", "Rodvin", "Hvitvin", "Rosevin", "Musserende"];

function formatDate(value: string | null) {
  if (!value) return "pending";
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}

function stockLabel(wine: Wine) {
  if (wine.stockStatus === "in_stock") return "Storo";
  if (wine.stockStatus === "oslo_stock") return "Oslo";
  if (wine.stockStatus === "not_found") return "Not at Storo";
  return "Unchecked";
}

function stars(rating: number | null) {
  if (!rating) return "Unrated";
  return `${rating.toFixed(1)} / 5`;
}

export default function WineRanker({ data, dataUrl }: { data: WineData; dataUrl: string }) {
  const [tab, setTab] = useState<"rated" | "unrated">("rated");
  const [category, setCategory] = useState("All");
  const [maxPrice, setMaxPrice] = useState(500);
  const [minRating, setMinRating] = useState(3.5);

  const active = tab === "rated" ? data.rated : data.unrated;
  const categories = useMemo(() => {
    const seen = new Set(active.map((wine) => wine.category).filter(Boolean));
    return categoryOrder.filter((item) => item === "All" || seen.has(item)).concat([...seen].filter((item) => !categoryOrder.includes(item)));
  }, [active]);

  const filtered = active.filter((wine) => {
    if (category !== "All" && wine.category !== category) return false;
    if (wine.price75 > maxPrice) return false;
    if (tab === "rated" && (wine.vivinoRating || 0) < minRating) return false;
    return true;
  });

  return (
    <main className="min-h-screen bg-[#f7f5ef] text-[#22251d]">
      <section className="border-b border-[#d7d2c4] bg-[#fbfaf6]">
        <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-8 sm:px-6 lg:px-8">
          <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <p className="text-sm font-semibold uppercase tracking-[0.18em] text-[#6c6f45]">Vinmonopolet Storo value ranker</p>
              <h1 className="mt-2 text-4xl font-semibold tracking-tight text-[#202315] sm:text-5xl">Best wine under the noise</h1>
              <p className="mt-3 max-w-2xl text-base leading-7 text-[#5d604f]">
                Vinmonopolet wines ranked by Vivino rating, price-adjusted value, and Storo availability.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              <div className="border border-[#d7d2c4] bg-white px-4 py-3">
                <div className="text-[#747763]">Rated</div>
                <div className="text-2xl font-semibold">{data.stats.rated}</div>
              </div>
              <div className="border border-[#d7d2c4] bg-white px-4 py-3">
                <div className="text-[#747763]">Matched</div>
                <div className="text-2xl font-semibold">{Math.round(data.stats.matchRate * 100)}%</div>
              </div>
              <div className="border border-[#d7d2c4] bg-white px-4 py-3">
                <div className="text-[#747763]">Data age</div>
                <div className="text-sm font-semibold">{formatDate(data.timestamp)}</div>
              </div>
            </div>
          </div>

          {data.warnings?.length > 0 && (
            <div className="border-l-4 border-[#a86f2a] bg-[#fff7e8] px-4 py-3 text-sm text-[#65420e]">
              {data.warnings[0]}
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto max-w-7xl px-4 py-5 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-4 border-b border-[#d7d2c4] pb-5">
          <div className="flex flex-wrap items-center gap-2">
            {(["rated", "unrated"] as const).map((item) => (
              <button
                key={item}
                onClick={() => setTab(item)}
                className={`border px-4 py-2 text-sm font-semibold ${tab === item ? "border-[#4f5a2a] bg-[#4f5a2a] text-white" : "border-[#c9c3b4] bg-white text-[#343829]"}`}
              >
                {item === "rated" ? "Rated" : "Unrated"}
              </button>
            ))}
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_220px_220px]">
            <div className="flex flex-wrap gap-2">
              {categories.map((item) => (
                <button
                  key={item}
                  onClick={() => setCategory(item)}
                  className={`border px-3 py-2 text-sm ${category === item ? "border-[#7d853f] bg-[#eef0d8]" : "border-[#d7d2c4] bg-white"}`}
                >
                  {item}
                </button>
              ))}
            </div>
            <label className="text-sm font-medium text-[#4b4f3e]">
              Max price: {maxPrice} kr
              <input className="mt-2 w-full accent-[#69723a]" type="range" min="100" max="1000" step="25" value={maxPrice} onChange={(event) => setMaxPrice(Number(event.target.value))} />
            </label>
            <label className="text-sm font-medium text-[#4b4f3e]">
              Min rating: {minRating.toFixed(1)}
              <input className="mt-2 w-full accent-[#69723a]" type="range" min="3.5" max="4.5" step="0.1" value={minRating} disabled={tab === "unrated"} onChange={(event) => setMinRating(Number(event.target.value))} />
            </label>
          </div>
        </div>

        <div className="mt-5 hidden overflow-hidden border border-[#d7d2c4] bg-white lg:block">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-[#ece8dc] text-xs uppercase tracking-[0.12em] text-[#5b6042]">
              <tr>
                <th className="px-4 py-3">Wine</th>
                <th className="px-4 py-3">Country</th>
                <th className="px-4 py-3">Category</th>
                <th className="px-4 py-3">Vivino</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">Score</th>
                <th className="px-4 py-3">Stock</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((wine) => (
                <tr key={wine.varenummer} className="border-t border-[#ebe6d8]">
                  <td className="px-4 py-3">
                    <a className="font-semibold text-[#1e2516] underline-offset-4 hover:underline" href={wine.url} target="_blank" rel="noreferrer">
                      {wine.name}
                    </a>
                    <div className="text-xs text-[#777966]">{wine.district || wine.varenummer}</div>
                  </td>
                  <td className="px-4 py-3">{wine.country}</td>
                  <td className="px-4 py-3">{wine.category}</td>
                  <td className="px-4 py-3 font-semibold">{stars(wine.vivinoRating)}</td>
                  <td className="px-4 py-3">{Math.round(wine.price75)} kr</td>
                  <td className="px-4 py-3 font-semibold">{wine.score.toFixed(3)}</td>
                  <td className="px-4 py-3">{stockLabel(wine)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-5 grid gap-3 lg:hidden">
          {filtered.map((wine) => (
            <article key={wine.varenummer} className="border border-[#d7d2c4] bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <a className="font-semibold text-[#1e2516]" href={wine.url} target="_blank" rel="noreferrer">
                  {wine.name}
                </a>
                <span className="whitespace-nowrap bg-[#eef0d8] px-2 py-1 text-xs font-semibold text-[#4f5a2a]">{stockLabel(wine)}</span>
              </div>
              <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-[#5d604f]">
                <span>{wine.country}</span>
                <span>{wine.category}</span>
                <span>{stars(wine.vivinoRating)}</span>
                <span>{Math.round(wine.price75)} kr</span>
              </div>
            </article>
          ))}
        </div>

        <footer className="mt-8 border-t border-[#d7d2c4] py-5 text-sm leading-6 text-[#60634f]">
          Stock data from {formatDate(data.sourceTimestamps.stock)}. Ratings from Vivino, fetched via {data.sourceTimestamps.ratingsFetchedFrom}. Contact:
          {" "}
          <a className="font-semibold underline" href="mailto:cesar.a.pinto@gmail.com">cesar.a.pinto@gmail.com</a>. Data endpoint: {dataUrl}.
        </footer>
      </section>
    </main>
  );
}
