#!/usr/bin/env bash
# CooperBench solo reference (lane 01M5GCF88Z, docs/research/cooperbench/solo-manifest.md).
# Smoke pair, then the solo arm on core, c=3, then eval. Hard stop $25 of model spend (nick,
# 2026-10-21), counted over every solo-* run's result.json (smoke and re-runs included).
set -uo pipefail
cd /data/runs
D=/data/runs/solo-2026-10-21
mkdir -p "$D"
CAP=24.95
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/solo.log"; }
spent() { python3 -c "
import json,glob
print(f'{sum(float(json.load(open(f)).get(\"total_cost\") or 0) for f in glob.glob(\"/data/runs/logs/solo-*/**/result.json\",recursive=True)):.2f}')"; }
if [ -z "${SKIP_SMOKE:-}" ]; then
log "smoke start"
cooperbench run -n solo-smoke -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code --setting solo --no-auto-eval > "$D/smoke.run.log" 2>&1
cooperbench eval -n solo-smoke --backend docker > "$D/smoke.eval.log" 2>&1
ok=$(python3 - <<'PY'
import glob, json
r = [json.load(open(f)) for f in glob.glob("/data/runs/logs/solo-smoke/**/result.json", recursive=True)]
e = [json.load(open(f)) for f in glob.glob("/data/runs/logs/solo-smoke/**/eval.json", recursive=True)]
# A solo result carries one "agent", a coop/team result "agents" (the 2026-10-21 false SMOKE FAIL).
good = bool(r) and bool(e) and all(a.get("status") == "Submitted" for x in r for a in (x.get("agents") or {"solo": x.get("agent") or {}}).values()) and all(x.get("error") is None for x in e)
print("yes" if good else "no")
PY
)
log "smoke ok=$ok spent=$(spent)"
[ "$ok" = yes ] || { log "SMOKE FAIL — stopping"; touch "$D/all.done"; exit 1; }
else log "smoke skipped: passed by hand at 23:34Z (Submitted, eval errors 0, \$0.48)"; fi
log "start solo arm"
cooperbench run -n solo-core -s core -m claude-sonnet-4-5 -a claude_code --setting solo -c 3 --no-auto-eval > "$D/solo-core.run.log" 2>&1 &
RUN=$!
while kill -0 $RUN 2>/dev/null; do
  s=$(spent); echo "$(date -u +%FT%TZ) spent=$s" > "$D/spend.txt"
  if python3 -c "import sys; sys.exit(0 if float('$s') >= $CAP else 1)"; then
    log "HARD STOP: \$$s reached \$$CAP"; pkill -f "cooperbench run"; break
  fi
  sleep 30
done
wait
log "run exit; eval"
cooperbench eval -n solo-core --backend docker > "$D/solo-core.eval.log" 2>&1
log "spent=$(spent) all done"
touch "$D/all.done"
