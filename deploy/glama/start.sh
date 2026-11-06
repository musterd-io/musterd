#!/bin/bash
# The Glama image's entrypoint (lane 01M6S9N6HK): a throwaway musterd team, then the MCP server on
# stdio. Glama builds the image, runs it, and talks MCP over stdin/stdout to list and score the
# tools. So stdout belongs to the MCP server alone — everything this script and the daemon say goes
# to stderr or a log file.
#
# Nothing here needs a secret and nothing leaves the container: the daemon binds loopback, the team
# and its seat key are minted fresh in a temp dir on every start and die with the container, and
# telemetry stays off (PRIVACY.md — OTLP starts only when an endpoint is set; OTEL_SDK_DISABLED
# makes that explicit).
set -euo pipefail

# The built CLI and adapter, found from this script's own checkout (Glama clones wherever it likes).
root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MUSTERD_BIN=${MUSTERD_BIN:-$root/packages/cli/dist/bin.js}
MCP_BIN=${MCP_BIN:-$root/packages/mcp/dist/index.js}
PORT=${MUSTERD_PORT:-4849}
TEAM=${MUSTERD_TEAM:-demo}
SEAT=${MUSTERD_SEAT:-inspector}

work=$(mktemp -d)
export HOME="$work/home" OTEL_SDK_DISABLED=true
mkdir -p "$HOME"
export MUSTERD_CONFIG="$work/config.json" MUSTERD_DB="$work/musterd.db"
export MUSTERD_PORT="$PORT" MUSTERD_SERVER="http://127.0.0.1:$PORT"

musterd() { node "$MUSTERD_BIN" "$@" </dev/null; }

# node itself in the background (not the shell function), so $! is the daemon the trap stops.
node "$MUSTERD_BIN" serve --host 127.0.0.1 --port "$PORT" </dev/null >"$work/daemon.log" 2>&1 &
daemon=$!
trap 'kill "$daemon" 2>/dev/null || true' EXIT
trap 'exit 143' TERM INT

for _ in $(seq 1 120); do
  node -e "fetch('$MUSTERD_SERVER/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" && break
  kill -0 "$daemon" 2>/dev/null || { echo "musterd daemon exited:" >&2; tail -40 "$work/daemon.log" >&2; exit 1; }
  sleep 0.25
done

# Setup chatter goes to a log, not stderr: `team add` prints a key line, and keys are never logged.
setup() { musterd "$@" >>"$work/setup.log" 2>&1 || { echo "musterd $1 $2 failed (setup log kept in the container)" >&2; exit 1; }; }
setup team create "$TEAM"
setup team add "$SEAT" --kind agent
key=$(musterd team bootstrap mint --seat "$SEAT" --json | node -e \
  "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);process.stdout.write(j.agent_key||j.key||'')})")
[ -n "$key" ] || { echo "minting the seat key failed" >&2; exit 1; }

echo "musterd: team '$TEAM' up on $MUSTERD_SERVER, MCP server on stdio as seat '$SEAT'" >&2

# Not exec: the trap must outlive the adapter to stop the daemon when stdin closes.
MUSTERD_TEAM="$TEAM" MUSTERD_AGENT_KEY="$key" MUSTERD_LAUNCH_SURFACE=other MUSTERD_CLAIM="seat:$SEAT" \
  node "$MCP_BIN"
