#!/usr/bin/env bash
set -euo pipefail

fresh() {
  local file="$1"
  [ -f "$file" ] || return 1
  node -e "const fs=require('fs'); process.exit(Date.now()-fs.statSync(process.argv[1]).mtimeMs < 24*60*60*1000 ? 0 : 1)" "$file"
}

mkdir -p data

if fresh data/products.json; then
  echo "products.json fresh; skipping scrape"
else
  node scripts/scrape-vinmonopolet.js
fi

if [ "${USE_OFFLINE_RATINGS:-false}" = "true" ]; then
  echo "Using offline Vivino dataset match"
  node scripts/match-vivino-offline.js
else
  node scripts/match-vivino.js
fi

if fresh data/stock.json; then
  echo "stock.json fresh; skipping stock check"
else
  node scripts/check-storo.js
fi

node scripts/merge-and-score.js
node scripts/firebase-upload.js
