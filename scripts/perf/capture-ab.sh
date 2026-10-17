#!/usr/bin/env bash
# The bench image's default run: the capture A/B (scripts/perf/capture-ab.mjs) against the synthetic
# fixture, then idle. Read the result with `fly logs -a musterd-bench --no-tail | grep CAPTURE_AB`.
set -euo pipefail
cd "$(dirname "$0")/../.."
bash scripts/perf/broadcast-bench-fixture.sh up
# Seats hold `inbox --watch` open; wait until the roster shows them present, or the room draws empty.
for _ in $(seq 1 60); do
  n=$(curl -fsS http://127.0.0.1:4877/teams/bench/members 2>/dev/null | grep -o '"presence":"online"' | wc -l || true)
  [ "${n:-0}" -ge 3 ] && break
  sleep 2
done
echo "CAPTURE_AB_SEATS online=${n:-0}"
# The page's observer seat (ADR 594), minted as the fixture's human admin — since ADR 580 the page
# cannot mint one over loopback. Both arms read it from the env; it is never printed.
ROOT="$(pwd)"
BENCH="${BENCH_ROOT:-${TMPDIR:-/tmp}/musterd-bench}"
MUSTERD_BROADCAST_SEAT="$(cd "$BENCH/admin" && MUSTERD_CONFIG="$BENCH/admin/config.json" \
  node "$ROOT/packages/cli/dist/bin.js" broadcast --mint-seat --team bench --server http://127.0.0.1:4877)"
export MUSTERD_BROADCAST_SEAT
# CAPTURE_AB_FPS / CAPTURE_AB_ARMS pick the rung and the arms (`fly deploy --env …`); unset is increment 4's run.
node scripts/perf/capture-ab.mjs --secs "${CAPTURE_AB_SECS:-60}" --fps "${CAPTURE_AB_FPS:-30}" \
  ${CAPTURE_AB_ARMS:+--arms "$CAPTURE_AB_ARMS"} || echo "CAPTURE_AB_FAILED $?"
exec sleep infinity
