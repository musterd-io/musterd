#!/usr/bin/env bash
# CooperBench rider 4 run (lane 01M5SZXMJX, docs/research/cooperbench/rider4-manifest.md).
# The host smokes run by hand first and are logged in run.log. This pulls the ten `core` task images,
# runs the musterd arm under run_arms.py (hard stop $25 of model spend over every r4-* run's
# result.json, API limit stop), evaluates it, then reads it with readout.py and the claim run's
# residue scripts, unchanged.
set -uo pipefail
cd /data/runs
D=/data/runs/r4-2026-10-25
mkdir -p "$D"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/r4.log"; }

python3 -c "import json; [print('akhatua/cooperbench-%s:task%s' % (t['repo'].removesuffix('_task').replace('_', '-'), t['task_id'])) for t in json.load(open('dataset/subsets/core.json'))['tasks']]" > "$D/images.txt"
log "pull $(wc -l < "$D/images.txt") images, df $(df -h /data | awk 'NR==2{print $4}') free"
while read -r img; do
  docker image inspect "$img" > /dev/null 2>&1 || docker pull -q "$img" >> "$D/pull.log" 2>&1 || { log "PULL FAILED $img"; exit 1; }
done < "$D/images.txt"
log "pulled, df $(df -h /data | awk 'NR==2{print $4}') free"

python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'r4-*' --cap 24.80 \
  --log "$D/r4.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' \
  --arm r4-musterd="cooperbench run -n r4-musterd -s core -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval > $D/r4-musterd.run.log 2>&1"
code=$?
log "run_arms exit=$code"
python3 /app/scripts/research/cooperbench/readout.py /data/runs/logs/r4-musterd > "$D/readout.json" 2> "$D/readout.err"
log "readout exit=$?"
touch "$D/all.done"
exit $code
