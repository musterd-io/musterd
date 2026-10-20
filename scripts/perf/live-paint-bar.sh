#!/bin/bash
# The live-loads-fast bar, in one command (lane 01M4VJS7EX). Run it from YOUR OWN musterd folder — the
# one `musterd whoami` says is you, a human — on the machine whose /live you want measured:
#
#   bash ~/.musterd/runtime/scripts/perf/live-paint-bar.sh [team] [runs]
#
# It mints a one-shot sign-in link with `musterd live` (dead after one use or 60 s, redeemable only on
# this machine), hands it to live-paint-bar.mjs without printing it, and prints the three medians.
# The JSON lands in /tmp/live-paint-bar-<host>.json; paste the printed block back to whoever asked.
set -euo pipefail
TEAM="${1:-revive}"
RUNS="${2:-5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${MUSTERD_PORT:-4849}"

command -v musterd >/dev/null || { echo "✗ musterd is not on PATH" >&2; exit 1; }
WHO="$(musterd whoami 2>/dev/null | head -1 || true)"
echo "▸ signing in as this folder's seat: ${WHO:-unknown}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
chmod 700 "$TMP"
musterd live --team "$TEAM" --print --no-open > "$TMP/out" 2>&1 || true
grep -oE 'https?://[^ ]+#s=[^ ]+' "$TMP/out" | head -1 > "$TMP/url" || true
if [ ! -s "$TMP/url" ]; then
  echo "✗ musterd live gave no sign-in link. It said:" >&2
  sed -E 's/#s=[^ ]+/#s=REDACTED/g' "$TMP/out" | head -5 >&2
  echo "  (agents cannot sign in to /live — run this from a human's own folder)" >&2
  exit 1
fi

node "$HERE/live-paint-bar.mjs" "http://localhost:${PORT}/live?team=${TEAM}" \
  --signin-url-file "$TMP/url" --runs "$RUNS" --json "/tmp/live-paint-bar-$(hostname -s).json"
echo "▸ machine: $(hostname -s) · load: $(uptime | sed 's/.*load averages*: //')"
