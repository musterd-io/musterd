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
node scripts/perf/capture-ab.mjs --secs "${CAPTURE_AB_SECS:-60}" || echo "CAPTURE_AB_FAILED $?"
exec sleep infinity
