#!/usr/bin/env bash
# Cost-fix stage 1 (costfix-manifest.md): baseline and lean on the 10 core pairs, concurrently,
# under run_arms.py (threshold $110 polled over every costfix* pair). No cost or pass verdict here.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
unset MUSTERD_ARM_LANE MUSTERD_ARM_LEAN
D=/data/runs/costfix-2026-11-06; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/stage1.log"; }
SUF=${1:-}   # "r" for the one allowed lean re-run
M=claude-opus-5-5
ARMS=(--arm "costfix1$SUF-lean=MUSTERD_ARM_LEAN=1 cooperbench run -n costfix1$SUF-lean -s core -m $M -a claude_code_musterd --setting coop --git -c 2 --no-auto-eval > $D/costfix1$SUF-lean.run.log 2>&1")
[ -z "$SUF" ] && ARMS+=(--arm "costfix1-base=cooperbench run -n costfix1-base -s core -m $M -a claude_code_musterd --setting coop --git -c 2 --no-auto-eval > $D/costfix1-base.run.log 2>&1")
log "stage 1$SUF start · $M · cap \$110"
python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'costfix*' --cap 110 \
  --log "$D/stage1.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' "${ARMS[@]}"
log "run_arms exit=$?"
python3 "$D/gates.py" /data/runs/logs "costfix1$SUF-lean" costfix1-base | tee -a "$D/stage1.log" > "$D/gates1$SUF.json"
touch "$D/stage1$SUF.done"
