#!/usr/bin/env bash
# Cost-fix seed 2: the baseline arm's cooperbench process was OOM-killed at ~20:26Z after 8 of 50
# pairs (dmesg: "Out of memory: Killed process 1434 (cooperbench)"). Manifest error rule: re-run the
# errored arm once. Same run name, no --force, so CooperBench skips the 8 pairs with results and runs
# the other 42. No pair of either arm had been evaluated when this was decided. Runs after the first
# run_arms finishes (solo done), alone on the machine.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
unset MUSTERD_ARM_LANE MUSTERD_ARM_LEAN
D=/data/runs/costfix-2026-11-06; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/stage2.log"; }
while [ ! -f "$D/stage2.done" ]; do sleep 20; done
log "resume: base arm OOM-killed ~20:26Z after 8/50 pairs; re-running the arm once (same name, skips finished pairs)"
docker ps -a --format '{{.Names}}' | grep -E '^(minisweagent-|cooperbench-git$)' | xargs -r docker rm -f >> "$D/resume.out" 2>&1
log "orphans removed; mem $(free -m | awk 'NR==2{print $7}') MB available"
M=claude-opus-5-5
python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'costfix*' --cap 110 \
  --log "$D/stage2.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' \
  --arm costfix2-base="cooperbench run -n costfix2-base -s flash -m $M -a claude_code_musterd --setting coop --git -c 2 --no-auto-eval > $D/costfix2-base.resume.log 2>&1"
log "resume run_arms exit=$?"
python3 /app/scripts/research/cooperbench/readout.py /data/runs/logs/costfix2-base > "$D/readout-base.json" 2> "$D/readout-base.err"; log "readout base exit=$?"
touch "$D/stage2b.done"
