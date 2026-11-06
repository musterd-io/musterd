#!/usr/bin/env bash
# Cost-fix stage 2 as amended after stage 1 (costfix-manifest.md): baseline and solo on the 50 flash pairs — seed 2 of C1 (K3).
set -uo pipefail
source /etc/profile.d/cooperbench.sh
unset MUSTERD_ARM_LANE MUSTERD_ARM_LEAN
D=/data/runs/costfix-2026-11-06; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/stage2.log"; }
M=claude-opus-5-5
log "stage 2 start · $M · cap \$110 · df $(df -h /data | awk 'NR==2{print $4}') free"
( while sleep 30; do
    avail=$(df -BG --output=avail /data | tail -1 | tr -dc 0-9)
    [ -f "$D/stage2.done" ] && exit 0
    if [ "${avail:-99}" -lt 4 ]; then log "DISK-STOP: /data ${avail}G free"; pkill -f "[r]un_arms.py"; pkill -f "[c]ooperbench run -n costfix2-"; sleep 5; docker ps -q --filter name=minisweagent | xargs -r docker rm -f; exit 0; fi
  done ) &
GUARD=$!
python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'costfix*' --cap 110 \
  --log "$D/stage2.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' \
  --arm costfix2-base="cooperbench run -n costfix2-base -s flash -m $M -a claude_code_musterd --setting coop --git -c 2 --no-auto-eval > $D/costfix2-base.run.log 2>&1" \
  --arm costfix2-solo="cooperbench run -n costfix2-solo -s flash -m $M -a claude_code --setting solo -c 1 --no-auto-eval > $D/costfix2-solo.run.log 2>&1"
log "run_arms exit=$?"
for a in base solo; do
  python3 /app/scripts/research/cooperbench/readout.py /data/runs/logs/costfix2-$a > "$D/readout-$a.json" 2> "$D/readout-$a.err"; log "readout $a exit=$?"
done
kill $GUARD 2>/dev/null
touch "$D/stage2.done"
