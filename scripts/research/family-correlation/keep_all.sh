#!/bin/sh
# The keep step over every task, one task at a time, on musterd-cooperbench.
# The task images run 1-13 GB and the docker volume cannot hold them all, so an image this script
# pulls is removed once its task is done; an image that was already cached is left in place.
#   sh keep_all.sh <run-dir> [concurrency]
set -eu
RUN="$1"
C="${2:-6}"
HERE="$(cd "$(dirname "$0")" && pwd)"
DATASET=/opt/cooperbench/dataset
TASKS=$(python3 -c "
import json, sys
seen = []
for l in open(sys.argv[1]):
    t = '/'.join(json.loads(l)['feature'].split('/')[:2])
    if t not in seen: seen.append(t)
print(' '.join(seen))" "$RUN/candidates.jsonl")
for t in $TASKS; do
  repo=$(echo "$t" | cut -d/ -f1 | sed 's/_task$//; s/_/-/g')
  n=$(echo "$t" | cut -d/ -f2)
  img="akhatua/cooperbench-$repo:$n"
  pulled=0
  if ! docker image inspect "$img" >/dev/null 2>&1; then
    echo "pull $img"
    docker pull -q "$img" >/dev/null
    pulled=1
  fi
  python3 "$HERE/keep.py" --dataset "$DATASET" --run "$RUN" -c "$C" --task "$t"
  if [ "$pulled" = 1 ]; then
    docker rmi -f "$img" >/dev/null && echo "removed $img"
  fi
done
echo "keep_all done"
