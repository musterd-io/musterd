#!/usr/bin/env bash
# CooperBench rider 7 re-run (lane 01M6MDXxxx, rider7-rerun-manifest.md): ten core pairs on the act lane
# under run_arms.py (hard stop $110 over every r7b-* result.json) beside wake_guard.py (live wakes).
set -uo pipefail
source /etc/profile.d/cooperbench.sh
cd /data/runs
D=/data/runs/r7b-2026-11-05; mkdir -p "$D"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/r7b.log"; }
export MUSTERD_ARM_LANE=act
python3 -c "import json; [print('akhatua/cooperbench-%s:task%s' % (t['repo'].removesuffix('_task').replace('_', '-'), t['task_id'])) for t in json.load(open('dataset/subsets/core.json'))['tasks']]" > "$D/images.txt"
log "pull $(wc -l < "$D/images.txt") images, df $(df -h /data | awk 'NR==2{print $4}') free"
while read -r img; do
  docker image inspect "$img" > /dev/null 2>&1 || docker pull -q "$img" >> "$D/pull.log" 2>&1 || { log "PULL FAILED $img"; exit 1; }
done < "$D/images.txt"
log "pulled · MUSTERD_ARM_LANE=$MUSTERD_ARM_LANE · guard pair cap \$6, total \$110"
python3 /app/scripts/research/cooperbench/wake_guard.py --pairs '/tmp/cb-musterd-*' --pair-cap 6 --total-cap 110 --every 30 \
  --finished /data/runs/logs --runs 'r7b-*' \
  --on-stop 'pkill -f "cooperbench run -n r7b-musterd"; sleep 3; docker ps -q --filter name=minisweagent | xargs -r docker rm -f' > "$D/guard.log" 2>&1 &
GUARD=$!
python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'r7b-*' --cap 110 \
  --log "$D/r7b.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' \
  --arm r7b-musterd="cooperbench run -n r7b-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval > $D/r7b-musterd.run.log 2>&1"
code=$?
log "run_arms exit=$code"
kill $GUARD 2>/dev/null; wait $GUARD 2>/dev/null; log "guard last: $(tail -1 "$D/guard.log")"
python3 /app/scripts/research/cooperbench/readout.py /data/runs/logs/r7b-musterd > "$D/readout.json" 2> "$D/readout.err"
log "readout exit=$?"
python3 /app/scripts/research/cooperbench/rider7.py /data/runs/logs/r7b-musterd "$D/readout.json" > "$D/rider7.json" 2> "$D/rider7.err"
log "rider7 exit=$?"
touch "$D/all.done"
exit $code
