#!/bin/bash
# Set the model key the CooperBench agents spend, as a Fly secret, without it ever being echoed,
# saved in shell history, or passed through a chat.
#
#   deploy/cooperbench/set-key.sh [--app musterd-cooperbench]
#
# Prompts for ANTHROPIC_API_KEY with no echo and pipes it to `fly secrets import` on stdin.
# Run it again to rotate the key; `fly secrets unset ANTHROPIC_API_KEY --app <app>` removes it.
set -euo pipefail
APP=musterd-cooperbench
[ "${1:-}" = "--app" ] && APP="$2"

command -v fly >/dev/null || { echo "needs flyctl: brew install flyctl, then fly auth login" >&2; exit 1; }
read -r -s -p "ANTHROPIC_API_KEY for $APP (input hidden): " KEY
echo
[ -n "$KEY" ] || { echo "no key entered; nothing changed" >&2; exit 1; }
printf 'ANTHROPIC_API_KEY=%s\n' "$KEY" | fly secrets import --app "$APP" --stage
unset KEY
echo "✓ ANTHROPIC_API_KEY staged on $APP — it takes effect on the next deploy or machine start"
