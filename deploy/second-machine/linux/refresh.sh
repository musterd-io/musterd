#!/bin/bash
# One refresh tick: fast-forward the runtime to origin/main, rebuild when the build stamp is behind,
# and restart the daemon and the wake actuator. A failed build leaves the running services alone.
set -euo pipefail
RUNTIME="$HOME/.musterd/runtime"
cd "$RUNTIME"
# The /live publisher (live.sh, a worktree of this checkout) fetches the same ref every minute;
# two fetches at once lose a ref lock ("cannot lock ref refs/remotes/origin/main", seen 2026-11-05).
# Under set -e that killed the tick, so a fetch gets three tries before it is a failure.
fetch_main() { local n; for n in 1 2 3; do git fetch -q origin main && return 0; sleep 2; done; return 1; }
fetch_main
git merge -q --ff-only origin/main
head="$(git rev-parse HEAD)"
built="$(node -p 'try{require(process.argv[1]).ref||""}catch(e){""}' "$RUNTIME/packages/cli/dist/build.json" 2>/dev/null || true)"
[ "$built" = "$head" ] && exit 0
echo "$(date -u +%FT%TZ) building ${head:0:8} (was ${built:0:8})"
pnpm install --frozen-lockfile
pnpm -r build
systemctl --user restart musterd-daemon.service musterd-host.service
echo "$(date -u +%FT%TZ) restarted on ${head:0:8}"
