#!/usr/bin/env bash
# Rider 7 re-run, error re-run once (manifest: an MCP startup failure is an error, re-run once under a new name).
set -uo pipefail
source /etc/profile.d/cooperbench.sh
D=/data/runs/r7b-2026-11-05; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/rerun.log"; }
export MUSTERD_ARM_LANE=act
log "re-run pallets_jinja_task/1559 f5,f8 as r7b-rerun-jinja (agent2 MCP absent at session start in the first run)"
python3 /app/scripts/research/cooperbench/wake_guard.py --pairs "/tmp/cb-musterd-*" --pair-cap 6 --total-cap 110 --every 30 --finished /data/runs/logs --runs "r7b-*" --on-stop "pkill -f [c]ooperbench.run.-n.r7b-rerun; sleep 3; docker ps -q --filter name=minisweagent | xargs -r docker rm -f" >> "$D/rerun-guard.log" 2>&1 &
G=$!
cooperbench run -n r7b-rerun-jinja -r pallets_jinja_task -t 1559 -f 5,8 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git --no-auto-eval > "$D/r7b-rerun-jinja.run.log" 2>&1
log "run exit=$?"
cooperbench eval -n r7b-rerun-jinja --backend docker > "$D/r7b-rerun-jinja.eval.log" 2>&1
log "eval exit=$?"
kill $G 2>/dev/null
touch "$D/rerun-jinja.done"
