#!/usr/bin/env bash
# CooperBench pilot 2 (lane 01M5FQBPHB, docs/research/cooperbench/pilot2-manifest.md).
# Two arms side by side, c=3 each, then eval. Hard stop: $75 total model spend (nick, 2026-10-21),
# of which $2.30 went to the smokes, so the arms stop at $72.70 of finished-pair cost.
set -uo pipefail
cd /data/runs
D=/data/runs/pilot2-2026-10-21
mkdir -p "$D"
CAP=72.70
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/pilot2.log"; }

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
for f in glob.glob("/data/runs/logs/p2-*/**/result.json", recursive=True):
    try: t += float(json.load(open(f)).get("total_cost") or 0)
    except Exception: pass
print(f"{t:.2f}")
PY
}

arm p2-musterd claude_code_musterd coop &
arm p2-team claude_code team &

while [ ! -f "$D/p2-musterd.done" ] || [ ! -f "$D/p2-team.done" ]; do
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
