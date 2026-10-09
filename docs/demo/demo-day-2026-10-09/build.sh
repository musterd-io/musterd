#!/usr/bin/env bash
# Renders BP_musterd.pdf from deck.html without the browser editor. Needs Chrome, as
# docs/brand/one-slide/README.md does. In the browser, press D on the served deck instead.
# Usage: ./build.sh [output-dir]   (default: this folder)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here}"
mkdir -p "$out"
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$out/BP_musterd.pdf" \
  --virtual-time-budget=2000 \
  "file://$here/deck.html" 2>&1 | grep -i "written" || true

# The PDF ends on the contact slide (nick, 2026-10-09); the HTML deck keeps it after the demo.
# Move the slide titled "Nick Sanders, founder" to the last page, using poppler's tools.
pdf="$out/BP_musterd.pdf"
n=$(grep -o 'data-title="[^"]*"' "$here/deck.html" | grep -n 'Nick Sanders, founder' | cut -d: -f1)
total=$(pdfinfo "$pdf" | awk '/^Pages:/{print $2}')
if [[ -n "$n" && "$n" -lt "$total" ]]; then
  pages="$(mktemp -d)"
  pdfseparate "$pdf" "$pages/p-%03d.pdf"
  order=()
  for ((k = 1; k <= total; k++)); do [[ $k -ne $n ]] && order+=("$(printf '%s/p-%03d.pdf' "$pages" "$k")"); done
  order+=("$(printf '%s/p-%03d.pdf' "$pages" "$n")")
  pdfunite "${order[@]}" "$pdf"
fi
