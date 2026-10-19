#!/usr/bin/env bash
# Pack this checkout's musterd CLI and MCP server (and the internal packages they import) into
# tarballs that a CooperBench agent container installs with `npm install -g --ignore-scripts`.
#
# Packed from the checkout, not pulled from npm: the published packages lag main, and a run must say
# exactly which musterd it measured (the build stamp in each dist/build.json). `--ignore-scripts`
# skips better-sqlite3's native build. Only `serve`, `service`, `reset` and `uninstall` load the
# server's store, and an agent container never runs those.
#
# Usage: scripts/research/cooperbench/pack.sh <out-dir>
set -euo pipefail

out="${1:?usage: pack.sh <out-dir>}"
root="$(cd "$(dirname "$0")/../../.." && pwd)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"

( cd "$root" && pnpm --filter @musterd/cli... build >/dev/null )
for pkg in protocol telemetry server mcp cli; do
  ( cd "$root/packages/$pkg" && pnpm pack --pack-destination "$out" >/dev/null )
done
ls "$out"/musterd-*.tgz
