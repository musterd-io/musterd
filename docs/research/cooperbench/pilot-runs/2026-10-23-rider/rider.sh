#!/usr/bin/env bash
# CooperBench rider run (lane 01M5MS3PK0, docs/research/cooperbench/rider-manifest.md).
# The host smokes run by hand first and are logged in run.log. This pulls the nine task images,
# runs the musterd arm under run_arms.py (hard stop $25 of model spend over every rider-* run's
# result.json, API limit stop), evaluates it, then reads it with readout.py.
set -uo pipefail
cd /data/runs
D=/data/runs/rider-2026-10-23
mkdir -p "$D"
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/rider.log"; }

# riderset lives on the root fs, which a machine restart resets: copy it from beside this script
# (uploaded; the deployed /app predates it).
cp "$D/riderset.json" dataset/subsets/riderset.json

python3 -c "import json; [print('akhatua/cooperbench-%s:task%s' % (t['repo'].removesuffix('_task').replace('_', '-'), t['task_id'])) for t in json.load(open('dataset/subsets/riderset.json'))['tasks']]" > "$D/images.txt"
log "pull $(wc -l < "$D/images.txt") images, df $(df -h /data | awk 'NR==2{print $4}') free"
while read -r img; do
  docker image inspect "$img" > /dev/null 2>&1 || docker pull -q "$img" >> "$D/pull.log" 2>&1 || { log "PULL FAILED $img"; exit 1; }
done < "$D/images.txt"
log "pulled, df $(df -h /data | awk 'NR==2{print $4}') free"

python3 /app/scripts/research/cooperbench/run_arms.py --logs /data/runs/logs --runs 'rider-*' --cap 24.95 \
  --log "$D/rider.log" \
  --on-stop 'docker ps -q --filter name=minisweagent | xargs -r docker rm -f' \
  --eval 'cooperbench eval -n {name} --backend docker' \
  --arm rider-musterd="cooperbench run -n rider-musterd -s riderset -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git -c 3 --no-auto-eval > $D/rider-musterd.run.log 2>&1"
code=$?
log "run_arms exit=$code"
python3 /app/scripts/research/cooperbench/readout.py /data/runs/logs/rider-musterd > "$D/readout.json" 2> "$D/readout.err"
log "readout exit=$?"
touch "$D/all.done"
exit $code
