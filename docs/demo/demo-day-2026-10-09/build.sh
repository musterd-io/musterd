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
