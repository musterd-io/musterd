#!/usr/bin/env bash
# Builds BP_musterd.pdf from deck.src.html. Needs Chrome, as docs/brand/one-slide/README.md does.
# Usage: ./build.sh [output-dir]   (default: this folder)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here}"
mkdir -p "$out"
tmp="$(mktemp -d)"
python3 - "$here/deck.src.html" "$here/../../design/assets/chip-sm.svg" "$tmp/deck.html" <<'PY'
import sys
src, chip_path, dst = sys.argv[1], sys.argv[2], sys.argv[3]
chip = " ".join(open(chip_path).read().split()).replace("<svg ", '<svg class="chip" aria-hidden="true" ', 1)
open(dst, "w").write(open(src).read().replace("{{CHIP}}", chip))
PY
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --headless --disable-gpu --no-pdf-header-footer \
  --print-to-pdf="$out/BP_musterd.pdf" \
  --virtual-time-budget=2000 \
  "file://$tmp/deck.html" 2>&1 | grep -i "written" || true
