#!/usr/bin/env bash
# Download the syllabus corpus listed in tests/corpus/corpus.json into
# tests/corpus/cache/ and record a sha256 for each download.
#
# Usage:
#   scripts/fetch-corpus.sh                 download everything, write cache/hashes.json
#   scripts/fetch-corpus.sh --check         also compare against tests/corpus/hashes.lock.json
#   scripts/fetch-corpus.sh --update-lock   also copy cache/hashes.json to hashes.lock.json
#
# If a cached file matches the lock but the live page's text has changed (for
# example a site that starts serving a bot-challenge page), the locked copy is
# kept, the live download is saved as <id>.<ext>.new, and the id is reported
# as CHANGED. --update-lock accepts the live download instead.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CORPUS="$ROOT/tests/corpus/corpus.json"
CACHE="$ROOT/tests/corpus/cache"
LOCK="$ROOT/tests/corpus/hashes.lock.json"
PDFTOTEXT="${PDFTOTEXT:-$(command -v pdftotext || echo /opt/homebrew/bin/pdftotext)}"
UA="Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36"

mode=""
case "${1:-}" in
  "") ;;
  --check | --update-lock) mode="$1" ;;
  *) echo "usage: $0 [--check | --update-lock]" >&2; exit 2 ;;
esac

mkdir -p "$CACHE"

failed=0
while IFS=$'\t' read -r id kind url; do
  ext="html"
  [[ "$kind" == "pdf" ]] && ext="pdf"
  out="$CACHE/$id.$ext"
  tmp="$out.part"
  code="$(curl -sSL --compressed -A "$UA" \
    -H "Accept: text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.8" \
    -H "Accept-Language: en-US,en;q=0.9" \
    --connect-timeout 15 --max-time 60 \
    --retry 3 --retry-delay 2 --retry-all-errors \
    -o "$tmp" -w '%{http_code}' "$url" 2>/dev/null)" || code="000"
  if [[ "$code" != "200" ]]; then
    echo "FAILED  $id (HTTP $code)"
    rm -f "$tmp"
    failed=$((failed + 1))
    continue
  fi
  [[ -f "$out" ]] && mv "$out" "$out.prev"
  mv "$tmp" "$out"
  if [[ "$kind" == "pdf" ]]; then
    "$PDFTOTEXT" -layout "$out" "$CACHE/$id.layout.txt"
    "$PDFTOTEXT" -raw "$out" "$CACHE/$id.raw.txt"
  fi
  echo "ok      $id"
done < <(python3 -I -c '
import json, sys
for e in json.load(open(sys.argv[1])):
    print(e["id"], e["kind"], e["url"], sep="\t")
' "$CORPUS")

# sha256 is over the raw download. Canvas, Google Docs and similar pages embed
# per-request tokens, so text_sha256 (scripts, styles and tags stripped,
# whitespace collapsed; pdftotext -layout output for PDFs) is what --check
# compares to decide whether the content changed.
python3 -I -c '
import hashlib, json, os, re, subprocess, sys
corpus, cache, lock_path, mode, pdftotext = sys.argv[1:6]
lock = json.load(open(lock_path)) if os.path.exists(lock_path) else {}

def visible_text(raw):
    t = raw.decode("utf-8", "replace")
    t = re.sub(r"(?is)<(script|style|noscript)\b.*?</\1\s*>", " ", t)
    t = re.sub(r"(?s)<[^>]*>", " ", t)
    return " ".join(t.split())

def pdf_text(path, base):
    subprocess.run([pdftotext, "-layout", path, base + ".layout.txt"], check=True)
    subprocess.run([pdftotext, "-raw", path, base + ".raw.txt"], check=True)

def digest(path, pdf, base):
    raw = open(path, "rb").read()
    if pdf:
        text = " ".join(open(base + ".layout.txt", errors="replace").read().split())
    else:
        text = visible_text(raw)
    return {
        "sha256": hashlib.sha256(raw).hexdigest(),
        "text_sha256": hashlib.sha256(text.encode()).hexdigest(),
    }

hashes = {}
for e in json.load(open(corpus)):
    pdf = e["kind"] == "pdf"
    base = os.path.join(cache, e["id"])
    path = base + (".pdf" if pdf else ".html")
    if not os.path.exists(path):
        continue
    h = digest(path, pdf, base)
    prev = path + ".prev"
    if os.path.exists(prev):
        locked = lock.get(e["id"])
        if (mode != "--update-lock" and locked
                and h["text_sha256"] != locked["text_sha256"]
                and hashlib.sha256(open(prev, "rb").read()).hexdigest() == locked["sha256"]):
            os.replace(path, path + ".new")
            os.replace(prev, path)
            if pdf:
                pdf_text(path, base)
            h = digest(path, pdf, base)
            print("CHANGED", e["id"], "(kept locked copy; live download saved as .new)")
        else:
            os.remove(prev)
    hashes[e["id"]] = h
with open(os.path.join(cache, "hashes.json"), "w") as f:
    json.dump(hashes, f, indent=2, sort_keys=True)
    f.write("\n")
' "$CORPUS" "$CACHE" "$LOCK" "$mode" "$PDFTOTEXT"

if [[ "$mode" == "--update-lock" ]]; then
  cp "$CACHE/hashes.json" "$LOCK"
  echo "wrote $LOCK"
elif [[ "$mode" == "--check" ]]; then
  if [[ ! -f "$LOCK" ]]; then
    echo "no lock file at $LOCK" >&2
    exit 0
  fi
  python3 -I -c '
import json, sys
lock = json.load(open(sys.argv[1]))
cur = json.load(open(sys.argv[2]))
ids = [e["id"] for e in json.load(open(sys.argv[3]))]
for i in ids:
    if i not in cur:
        print("MISSING", i)
    elif i not in lock:
        print("NEW    ", i)
    elif lock[i]["text_sha256"] != cur[i]["text_sha256"]:
        print("CHANGED", i)
' "$LOCK" "$CACHE/hashes.json" "$CORPUS"
  exit 0
fi

if (( failed > 0 )); then
  echo "$failed download(s) failed" >&2
  exit 1
fi
