const path = require("path");
const { chromium } = require("playwright");
const { DATA_DIR, sleep, writeJson } = require("./common");

const USER_AGENTS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_4) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15",
];
const QUERIES = ["barolo", "chianti", "rioja", "riesling", "champagne", "chablis", "pinot noir", "sancerre", "malbec", "prosecco"];

function classify(status, text, title) {
  const haystack = `${title}\n${text}`.toLowerCase();
  if (status === 403 || status === 429 || /cloudflare|attention required|cf-ray|captcha|verify you are human|access denied/.test(haystack)) {
    return "blocked";
  }
  if (/showing 1-|vivino average rating|ratings\)|wine/.test(haystack)) return "content";
  return "unknown";
}

(async () => {
  const results = [];
  for (let session = 0; session < 2; session += 1) {
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ userAgent: USER_AGENTS[session], locale: "en-US" });
    const page = await context.newPage();
    for (let request = 0; request < 25; request += 1) {
      const query = QUERIES[(session * 25 + request) % QUERIES.length];
      const url = `https://www.vivino.com/search/wines?q=${encodeURIComponent(query)}`;
      let status = 0;
      let title = "";
      let label = "error";
      let finalUrl = url;
      try {
        const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        status = response?.status() || 0;
        await page.waitForTimeout(1000);
        title = await page.title().catch(() => "");
        finalUrl = page.url();
        const text = await page.locator("body").innerText({ timeout: 5000 }).catch(() => "");
        label = classify(status, text.slice(0, 2000), title);
      } catch (error) {
        label = `error:${error.name || "Error"}`;
      }
      const row = { session: session + 1, request: request + 1, status, label, title, finalUrl };
      results.push(row);
      console.log(JSON.stringify(row));
      await sleep(3000);
    }
    await browser.close();
  }
  const summary = results.reduce((acc, row) => {
    acc[row.label] = (acc[row.label] || 0) + 1;
    return acc;
  }, {});
  writeJson(path.join(DATA_DIR, "spike-vivino.json"), { ranAt: new Date().toISOString(), summary, results });
  console.log(JSON.stringify(summary, null, 2));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
