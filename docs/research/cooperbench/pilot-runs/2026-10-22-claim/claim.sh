#!/usr/bin/env bash
# CooperBench claim run (lane 01M5GWBB17, docs/research/cooperbench/claim-manifest.md).
# Steps 5-6: pull the new pairs' images, then musterd and solo side by side on claim20, c=3 each,
# then eval. Hard stop: $60 of model spend, counted over every claim-* run's result.json (the
# smoke pair and any claimr- error re-runs included). Steps 2-4 (API check, smokes, smoke pair)
# run by hand first and are logged in run.log.
set -uo pipefail
cd /data/runs
D=/data/runs/claim-2026-10-22
mkdir -p "$D"
CAP=59.95
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/claim.log"; }

spent() {
  python3 - <<'PY'
import json, glob
t = 0.0
for f in glob.glob("/data/runs/logs/claim*/**/result.json", recursive=True):
    try: t += float(json.load(open(f)).get("total_cost") or 0)
    except Exception: pass
print(f"{t:.2f}")
PY
}

cp "$D/claim20.json" dataset/subsets/claim20.json   # uploaded beside this script; the deployed /app predates it
log "prepare claim20 (image pulls) spent=$(spent)"
cooperbench prepare -s claim20 > "$D/prepare.log" 2>&1
log "prepare exit=$?"

arm() {  # name agent setting [--git]
  log "start $1"
  cooperbench run -n "$1" -s claim20 -m claude-sonnet-4-5 -a "$2" --setting "$3" ${4:-} -c 3 --no-auto-eval > "$D/$1.run.log" 2>&1
  log "$1 run exit=$?"
  cooperbench eval -n "$1" --backend docker > "$D/$1.eval.log" 2>&1
  log "$1 eval exit=$?"
  touch "$D/$1.done"
}

arm claim-musterd claude_code_musterd coop --git &
arm claim-solo claude_code solo &

while [ ! -f "$D/claim-musterd.done" ] || [ ! -f "$D/claim-solo.done" ]; do
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
