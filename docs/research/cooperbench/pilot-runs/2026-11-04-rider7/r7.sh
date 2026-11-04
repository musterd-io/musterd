#!/usr/bin/env bash
# CooperBench rider 7 run (lane 01M6M3YG37, docs/research/cooperbench/rider7-manifest.md): the ten
# `core` pairs on the act lane under run_arms.py (hard stop $24.80 over every r7-* run), eval, readout.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
cd /data/runs
D=/data/runs/r7-2026-11-04; mkdir -p "$D"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/r7.log"; }
export MUSTERD_ARM_LANE=act
python3 -c "import json; [print('akhatua/cooperbench-%s:task%s' % (t['repo'].removesuffix('_task').replace('_', '-'), t['task_id'])) for t in json.load(open('dataset/subsets/core.json'))['tasks']]" > "$D/images.txt"
log "pull $(wc -l < "$D/images.txt") images, df $(df -h /data | awk 'NR==2{print $4}') free"
while read -r img; do
  docker image inspect "$img" > /dev/null 2>&1 || docker pull -q "$img" >> "$D/pull.log" 2>&1 || { log "PULL FAILED $img"; exit 1; }
done < "$D/images.txt"
log "pulled, df $(df -h /data | awk 'NR==2{print $4}') free · MUSTERD_ARM_LANE=$MUSTERD_ARM_LANE"
python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'r7-*' --cap 24.80 \
  --log "$D/r7.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' \
  --arm r7-musterd="cooperbench run -n r7-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval > $D/r7-musterd.run.log 2>&1"
code=$?
log "run_arms exit=$code"
python3 /app/scripts/research/cooperbench/readout.py /data/runs/logs/r7-musterd > "$D/readout.json" 2> "$D/readout.err"
log "readout exit=$?"
python3 /app/scripts/research/cooperbench/rider7.py /data/runs/logs/r7-musterd "$D/readout.json" > "$D/rider7.json" 2> "$D/rider7.err"
log "rider7 exit=$?"
touch "$D/all.done"
exit $code
