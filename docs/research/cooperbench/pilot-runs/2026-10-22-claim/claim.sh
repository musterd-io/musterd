#!/usr/bin/env bash
# CooperBench claim run (lane 01M5GWBB17, docs/research/cooperbench/claim-manifest.md).
# Steps 5-6, in two halves because the 20 task images (83 GB) do not fit the 79 GB volume at once:
# `core`, then the ten new tasks (`claimnew`), each with musterd and solo side by side, c=3 each,
# then eval. Before each half, the other half's images are removed and this half's are pulled, so no
# arm pays for pulls in its wall time. Hard stop: $60 of model spend over every claim-* run's
# result.json (smoke pair and claimr- error re-runs included), across both halves. Steps 2-4 (API
# check, smokes, smoke pair) ran by hand first and are logged in run.log.
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
over() { python3 -c "import sys; sys.exit(0 if float('$(spent)') >= $CAP else 1)"; }

# claimnew: the ten new tasks of claim20.json (uploaded beside this script; the deployed /app predates it).
python3 - "$D/claim20.json" > dataset/subsets/claimnew.json <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
t = {}
for n in d["new"]:
    t.setdefault((n["repo"], n["task_id"]), []).append(n["pair"])
json.dump({"name": "claimnew", "tasks": [{"repo": r, "task_id": i, "pairs": p} for (r, i), p in t.items()]}, sys.stdout)
PY

images() {  # subset -> image names
  python3 -c "import json; [print('akhatua/cooperbench-%s:task%s' % (t['repo'].removesuffix('_task').replace('_', '-'), t['task_id'])) for t in json.load(open('dataset/subsets/$1.json'))['tasks']]"
}

arm() {  # name subset agent setting [--git]
  log "start $1"
  cooperbench run -n "$1" -s "$2" -m claude-sonnet-4-5 -a "$3" --setting "$4" ${5:-} -c 3 --no-auto-eval > "$D/$1.run.log" 2>&1
  log "$1 run exit=$?"
  cooperbench eval -n "$1" --backend docker > "$D/$1.eval.log" 2>&1
  log "$1 eval exit=$?"
  touch "$D/$1.done"
}

half() {  # subset suffix other-subset
  images "$3" | while read -r img; do docker rmi -f "$img" > /dev/null 2>&1; done
  log "pull $1 images, df $(df -h /data | awk 'NR==2{print $4}') free, spent=$(spent)"
  images "$1" | while read -r img; do
    docker image inspect "$img" > /dev/null 2>&1 || docker pull -q "$img" >> "$D/pull.log" 2>&1 || { log "PULL FAILED $img"; exit 1; }
  done || { touch "$D/all.done"; exit 1; }
  log "pulled $1, df $(df -h /data | awk 'NR==2{print $4}') free"
  arm "claim-musterd-$2" "$1" claude_code_musterd coop --git &
  arm "claim-solo-$2" "$1" claude_code solo &
  while [ ! -f "$D/claim-musterd-$2.done" ] || [ ! -f "$D/claim-solo-$2.done" ]; do
    echo "$(date -u +%FT%TZ) spent=$(spent)" > "$D/spend.txt"
    if over; then
      log "HARD STOP: finished-pair spend \$$(spent) reached \$$CAP"
      pkill -f "cooperbench run" ; sleep 5
      docker ps -q --filter name=minisweagent | xargs -r docker rm -f
      wait; touch "$D/all.done"; exit 1
    fi
    sleep 60
  done
  wait
  log "half $2 done spent=$(spent)"
}

half core core claimnew
half claimnew new core
log "spent=$(spent) all done"
touch "$D/all.done"
