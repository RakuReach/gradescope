#!/usr/bin/env bash
# Builds dist/gradescope-plus-<version>.zip for the Chrome Web Store.
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(python3 -c "import json; print(json.load(open('manifest.json'))['version'])")
mkdir -p dist
out="dist/gradescope-plus-${version}.zip"
rm -f "$out"
zip -rq "$out" manifest.json content.js content.css images icons -x '.*'
echo "$out"
