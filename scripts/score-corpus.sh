#!/usr/bin/env bash
# Scores syllabus.js against tests/corpus in headless Chrome. Run scripts/fetch-corpus.sh first.
# Usage: score-corpus.sh [--reveal] [--id <entry-id> [--dump]]
#   --reveal  also print held-out entries (only when you are done tuning against the dev set)
set -euo pipefail
cd "$(dirname "$0")/.."
hash="" query=""
while [ $# -gt 0 ]; do
  case "$1" in
    --reveal) hash="#reveal" ;;
    --id) query="?id=$2"; shift ;;
    --dump) query="$query&dump=1" ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
chrome="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"
profile=$(mktemp -d)
dom=$(mktemp)
trap 'rm -rf "$profile" "$dom"' EXIT
"$chrome" --headless=new --user-data-dir="$profile" --allow-file-access-from-files \
  --virtual-time-budget=60000 --dump-dom "file://$PWD/tests/corpus/score.html$query$hash" > "$dom" 2>/dev/null &
pid=$!
for _ in $(seq 1 240); do grep -q "</html>" "$dom" && break; sleep 0.5; done
kill "$pid" 2>/dev/null || true
python3 -I -c '
import html, re, sys
m = re.search(r"<pre id=\"out\">(.*?)</pre>", open(sys.argv[1]).read(), re.S)
print(html.unescape(m.group(1)) if m else "no output (did Chrome time out?)")
' "$dom"
