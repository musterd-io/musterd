#!/usr/bin/env bash
# CooperBench flash comparison step 3–4 (flash-manifest.md): pull, then the three arms concurrently
# under run_arms.py (hard stop: cap 370 over every finished flash-* pair, smoke included).
set -uo pipefail
source /etc/profile.d/cooperbench.sh
unset MUSTERD_ARM_LANE
D=/data/runs/flash-2026-11-06; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/flash2.log"; }
python3 -c "import json; [print('akhatua/cooperbench-%s:task%s' % (t['repo'].removesuffix('_task').replace('_', '-'), t['task_id'])) for t in json.load(open('dataset/subsets/flash.json'))['tasks']]" > "$D/images.txt"
log "pull $(wc -l < "$D/images.txt") images, df $(df -h /data | awk 'NR==2{print $4}') free"
while read -r img; do
  docker image inspect "$img" > /dev/null 2>&1 || docker pull -q "$img" >> "$D/pull.log" 2>&1 || { log "PULL FAILED $img"; exit 1; }
done < "$D/images.txt"
M=claude-opus-5-5
log "pulled · model $M · cap \$370 · arms concurrent · second attempt (flash2-*), disk guard at 4 GB free"
# Disk guard (attempt 1 filled /data): stop every arm cleanly if the Docker volume runs low.
( while sleep 30; do
    avail=$(df -BG --output=avail /data | tail -1 | tr -dc 0-9)
    [ -f "$D/all.done" ] && exit 0
    if [ "${avail:-99}" -lt 4 ]; then log "DISK-STOP: /data ${avail}G free"; pkill -f "[r]un_arms.py"; pkill -f "[c]ooperbench run -n flash2-"; sleep 5; docker ps -q --filter name=minisweagent | xargs -r docker rm -f; exit 0; fi
  done ) &
GUARD=$!
python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'flash*' --cap 370 \
  --log "$D/flash2.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' \
  --arm flash2-solo="cooperbench run -n flash2-solo -s flash -m $M -a claude_code --setting solo -c 1 --no-auto-eval > $D/flash2-solo.run.log 2>&1" \
  --arm flash2-team="cooperbench run -n flash2-team -s flash -m $M -a claude_code --setting team -c 2 --no-auto-eval > $D/flash2-team.run.log 2>&1" \
  --arm flash2-musterd="cooperbench run -n flash2-musterd -s flash -m $M -a claude_code_musterd --setting coop --git -c 2 --no-auto-eval > $D/flash2-musterd.run.log 2>&1"
code=$?
log "run_arms exit=$code"
for a in solo team musterd; do
  python3 /app/scripts/research/cooperbench/readout.py /data/runs/logs/flash2-$a > "$D/readout-$a.json" 2> "$D/readout-$a.err"; log "readout $a exit=$?"
done
kill $GUARD 2>/dev/null
touch "$D/all.done"
exit $code
