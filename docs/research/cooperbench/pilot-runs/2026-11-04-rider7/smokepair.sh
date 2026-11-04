#!/usr/bin/env bash
# Rider 7 step 4: one smoke pair on the act lane (not scored, not read). Must show a wake leased
# and resumed in each container's host log and a wake row in the pair's residency report.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
D=/data/runs/r7-2026-11-04; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/smokepair.log"; }
export MUSTERD_ARM_LANE=act
docker pull -q akhatua/cooperbench-pallets-click:task2068 >> "$D/pull.log" 2>&1
log "smoke pair start"
cooperbench run -n r7-smoke -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git --no-auto-eval > "$D/r7-smoke.run.log" 2>&1
log "smoke pair exit=$?"
for f in $(find /data/runs/logs/r7-smoke -name '*_host.log'); do log "$f: $(grep -c 'wake due' "$f") due, $(grep -c -i 'occupied\|resumed' "$f") occupied/resumed lines"; done
for f in $(find /data/runs/logs/r7-smoke -name 'musterd-residency.json'); do log "$f: $(python3 -c "import json,sys; r=json.load(open('$f')); print('wakes', r.get('wakes'), 'resumed', r.get('resumed'), 'failed', r.get('failed'), 'cost', r.get('cost_usd_total'))")"; done
find /data/runs/logs/r7-smoke -name 'result.json' -exec python3 -c "import json,sys; r=json.load(open(sys.argv[1])); print(sys.argv[1], 'cost', r.get('cost'), 'status', r.get('status'), 'error', r.get('error'))" {} \; | tee -a "$D/smokepair.log"
