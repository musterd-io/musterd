#!/usr/bin/env bash
# CooperBench pilot 3 (lane 01M5G70VZS, docs/research/cooperbench/pilot3-manifest.md).
# Two arms side by side, c=3 each, then eval. Hard stop: $65 total model spend (nick, 2026-10-21),
# less ~$0.05 of API check and smoke runs; the smoke pair and any p3r- error re-runs are counted by the p3* glob below.
set -uo pipefail
cd /data/runs
D=/data/runs/pilot3-2026-10-21
mkdir -p "$D"
CAP=64.95
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/pilot3.log"; }

arm() {  # name agent setting
  log "start $1"
  cooperbench run -n "$1" -s core -m claude-sonnet-4-5 -a "$2" --setting "$3" --git -c 3 --no-auto-eval > "$D/$1.run.log" 2>&1
  log "$1 run exit=$?"
  cooperbench eval -n "$1" --backend docker > "$D/$1.eval.log" 2>&1
  log "$1 eval exit=$?"
  touch "$D/$1.done"
}

spent() {
  python3 - <<'PY'
import json, glob
t = 0.0
for f in glob.glob("/data/runs/logs/p3*/**/result.json", recursive=True):
    try: t += float(json.load(open(f)).get("total_cost") or 0)
    except Exception: pass
print(f"{t:.2f}")
PY
}

arm p3-musterd claude_code_musterd coop &
arm p3-team claude_code team &

while [ ! -f "$D/p3-musterd.done" ] || [ ! -f "$D/p3-team.done" ]; do
  s=$(spent)
  echo "$(date -u +%FT%TZ) spent=$s" > "$D/spend.txt"
  if python3 -c "import sys; sys.exit(0 if float('$s') >= $CAP else 1)"; then
    log "HARD STOP: finished-pair spend \$$s reached \$$CAP"
    pkill -f "cooperbench run" ; sleep 5
    docker ps -q --filter name=minisweagent | xargs -r docker rm -f
    break
  fi
  sleep 60
done
wait
log "spent=$(spent) all done"
touch "$D/all.done"
