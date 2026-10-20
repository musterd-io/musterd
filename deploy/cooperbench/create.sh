#!/bin/bash
# Create the CooperBench run machine (lane 01M5AQE75K) in one command: the app, its 50 GB volume,
# the model key (asked for without echo, via set-key.sh), and the first deploy.
#
#   deploy/cooperbench/create.sh [--org <org>] [--region <region>] [--app <name>] [--dry-run]
#
# Run from the repo root. Needs flyctl logged in (`fly auth login`). Nothing here prints a secret.
set -euo pipefail
ORG=personal
REGION=sjc
APP=musterd-cooperbench
DRY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --org) ORG="$2"; shift 2 ;;
    --region) REGION="$2"; shift 2 ;;
    --app) APP="$2"; shift 2 ;;
    --dry-run) DRY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
run() { if [ "$DRY" = 1 ]; then echo "+ $*"; else "$@"; fi; }
here="$(cd "$(dirname "$0")" && pwd)"

command -v fly >/dev/null || { echo "needs flyctl: brew install flyctl, then fly auth login" >&2; exit 1; }
[ -f deploy/cooperbench/fly.toml ] || { echo "run from the repo root" >&2; exit 2; }

if fly apps list --org "$ORG" 2>/dev/null | awk '{print $1}' | grep -qx "$APP"; then
  echo "· app $APP exists"
else
  run fly apps create "$APP" --org "$ORG"
fi
if fly volumes list --app "$APP" 2>/dev/null | grep -q cb_data; then
  echo "· volume cb_data exists"
else
  run fly volumes create cb_data --app "$APP" --region "$REGION" --size 50 --yes
fi
if [ "$DRY" = 1 ]; then echo "+ $here/set-key.sh --app $APP"; else "$here/set-key.sh" --app "$APP"; fi
run fly deploy --app "$APP" --config deploy/cooperbench/fly.toml --dockerfile deploy/cooperbench/Dockerfile --primary-region "$REGION" --ha=false .
echo "✓ $APP is up. Runs: see docs/research/cooperbench/README.md. Stop it when done: fly machine stop --app $APP"
