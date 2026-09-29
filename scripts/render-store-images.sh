#!/usr/bin/env bash
# Renders store/src/*.html into store/images/ at Chrome Web Store sizes (24-bit PNG, no alpha).
set -euo pipefail
cd "$(dirname "$0")/.."
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
profile=$(mktemp -d)
trap 'rm -rf "$profile"' EXIT
mkdir -p store/images

render() { # <page> <width> <height> <output>
  rm -f "$4"
  # Headless Chrome on macOS can hang after writing the screenshot, so stop it once the file lands.
  "$chrome" --headless=new --user-data-dir="$profile" --hide-scrollbars \
    --force-device-scale-factor=1 --virtual-time-budget=4000 \
    --window-size="$2,$3" --screenshot="$PWD/$4" "file://$PWD/store/src/$1" >/dev/null 2>&1 &
  local pid=$!
  for _ in $(seq 1 120); do
    [[ -s "$4" ]] && break
    sleep 0.5
  done
  sleep 1
  kill "$pid" 2>/dev/null || true
  wait "$pid" 2>/dev/null || true
  [[ -s "$4" ]] || { echo "failed: $4" >&2; return 1; }
  python3 -c "from PIL import Image; import sys; p=sys.argv[1]; Image.open(p).convert('RGB').save(p)" "$4"
  echo "$4"
}

render shot1.html 1280 800 store/images/screenshot-1-countdown.png
render shot2.html 1280 800 store/images/screenshot-2-grade.png
render shot3.html 1280 800 store/images/screenshot-3-tiers.png
render promo-small.html 440 280 store/images/promo-small-440x280.png
render promo-marquee.html 1400 560 store/images/promo-marquee-1400x560.png
