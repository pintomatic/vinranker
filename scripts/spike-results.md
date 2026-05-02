# Wine Ranker Spike Results

Date: 2026-05-02

## Spike A: Storo Stock Endpoint

Pass.

- Product availability endpoint: `https://www.vinmonopolet.no/vmpws/v3/vmp/products/{varenummer}/availability`
- Auth: none
- Response shape: top-level `deliveryAvailability` and `storesAvailability`, each with `availableForPurchase`, `infos`, and `openStockLocator`.
- Store assortment endpoint for Storo: `https://www.vinmonopolet.no/vmpws/v2/vmp/products/search?fields=FULL&pageSize=100&currentPage=0&q=:relevance:availableInStores:161&searchType=product`
- Storo store code: `161`
- Implementation decision: `check-storo.js` builds a set of Storo product codes from `availableInStores:161`, then checks the top 200 scored wines. If fewer than 50 are confirmed at Storo, it adds an Oslo-store fallback and flags that in `wine-data.json`.

## Spike B: Vivino Blocking

Pass.

- Ran 50 Playwright requests across 2 browser sessions.
- Delay: 3 seconds between requests.
- User agents: Windows Chrome and macOS Safari.
- Result: 50/50 returned HTTP 200 with real Vivino result content.
- Cloudflare/CAPTCHA/access-denied detections: 0/50.
- Implementation decision: Playwright remains the primary Vivino source for v1. `match-vivino.js` keeps a 1-month cache keyed by Vinmonopolet varenummer and only accepts matches at JW-like score >= 0.85 by default.
