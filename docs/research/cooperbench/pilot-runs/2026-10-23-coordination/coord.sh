#!/usr/bin/env bash
# CooperBench coordination run (lane 01M5K1BCVG, docs/research/cooperbench/coordination-manifest.md).
# Step 2: one coop smoke pair. Step 3: team and coop side by side on claimnew, c=3 each, then eval.
# Hard stop: $35 of model spend over every coord-* run's result.json (smoke and re-runs included).
set -uo pipefail
cd /data/runs
D=/data/runs/coord-2026-10-23
mkdir -p "$D"
CAP=34.95
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/coord.log"; }
spent() { python3 -c "
import json,glob
print(f'{sum(float(json.load(open(f)).get(\"total_cost\") or 0) for f in glob.glob(\"/data/runs/logs/coord-*/**/result.json\",recursive=True)):.2f}')"; }

# claimnew lives on the root fs, which a machine restart resets: rebuild it from claim20.json.
python3 - /data/runs/claim-2026-10-22/claim20.json > dataset/subsets/claimnew.json <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t = {}
for n in d["new"]:
    t.setdefault((n["repo"], n["task_id"]), []).append(n["pair"])
json.dump({"name": "claimnew", "tasks": [{"repo": r, "task_id": i, "pairs": p} for (r, i), p in t.items()]}, sys.stdout)
PY

log "coop smoke start"
cooperbench run -n coord-smoke -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code --setting coop --git --no-auto-eval > "$D/smoke.run.log" 2>&1
cooperbench eval -n coord-smoke --backend docker > "$D/smoke.eval.log" 2>&1
ok=$(python3 - <<'PY'
import glob, json
r = [json.load(open(f)) for f in glob.glob("/data/runs/logs/coord-smoke/**/result.json", recursive=True)]
e = [json.load(open(f)) for f in glob.glob("/data/runs/logs/coord-smoke/**/eval.json", recursive=True)]
good = bool(r) and bool(e) and all(a.get("status") == "Submitted" for x in r for a in (x.get("agents") or {}).values()) and all(x.get("error") is None for x in e)
print("yes" if good else "no")
PY
)
log "smoke ok=$ok spent=$(spent)"
[ "$ok" = yes ] || { log "SMOKE FAIL — stopping"; touch "$D/all.done"; exit 1; }

arm() {  # name setting
  log "start $1"
  cooperbench run -n "$1" -s claimnew -m claude-sonnet-4-5 -a claude_code --setting "$2" --git -c 3 --no-auto-eval > "$D/$1.run.log" 2>&1
  log "$1 run exit=$?"
  cooperbench eval -n "$1" --backend docker > "$D/$1.eval.log" 2>&1
  log "$1 eval exit=$?"
  touch "$D/$1.done"
}
arm coord-team team &
arm coord-coop coop &
while [ ! -f "$D/coord-team.done" ] || [ ! -f "$D/coord-coop.done" ]; do
  echo "$(date -u +%FT%TZ) spent=$(spent)" > "$D/spend.txt"
  if python3 -c "import sys; sys.exit(0 if float('$(spent)') >= $CAP else 1)"; then
    log "HARD STOP: finished-pair spend \$$(spent) reached \$$CAP"
    pkill -f "cooperbench run"; sleep 5
    docker ps -q --filter name=minisweagent | xargs -r docker rm -f
    break
  fi
  sleep 60
done
wait
log "spent=$(spent) all done"
touch "$D/all.done"
