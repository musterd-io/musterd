#!/usr/bin/env bash
# Rider 7 re-run step 4: one smoke pair on the act lane under the wake guard ($6 a pair).
set -uo pipefail
source /etc/profile.d/cooperbench.sh
D=/data/runs/r7b-2026-11-05; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/smokepair.log"; }
export MUSTERD_ARM_LANE=act
docker pull -q akhatua/cooperbench-pallets-click:task2068 >> "$D/pull.log" 2>&1
log "smoke pair start (guard: pair cap \$6)"
python3 /app/scripts/research/cooperbench/wake_guard.py --pairs '/tmp/cb-musterd-*' --pair-cap 6 --total-cap 110 --every 30 \
  --on-stop 'pkill -f "cooperbench run -n r7b-smoke"; sleep 3; docker ps -q --filter name=minisweagent | xargs -r docker rm -f' > "$D/smoke-guard.log" 2>&1 &
GUARD=$!
cooperbench run -n r7b-smoke -r pallets_click_task -t 2068 -f 1,2 -m claude-sonnet-4-5 -a claude_code_musterd --setting coop --git --no-auto-eval > "$D/r7b-smoke.run.log" 2>&1
log "smoke pair exit=$?"
kill $GUARD 2>/dev/null; wait $GUARD 2>/dev/null
for f in $(find /data/runs/logs/r7b-smoke -name '*_host.log'); do log "$f: $(grep -c 'wake due' "$f") due · $(grep -c 'session=resumed' "$f") resumed · $(grep -c 'session=fresh' "$f") fresh · $(grep -c 'resume would re-ingest\|resume price unknown' "$f") price-bound"; done
for f in $(find /data/runs/logs/r7b-smoke -name 'musterd-residency.json'); do log "$f: $(python3 -c "import json; r=json.load(open('$f')); print('wakes', r.get('wakes'), 'resumed', r.get('resumed'), 'failed', r.get('failed'), 'cost', round(r.get('cost_usd_total') or 0,2), 'reclaimable_s', [round(h['by_state'].get('reclaimable',0)/1000,1) for s in r['by_seat'] for h in s.get('holds',[])])")"; done
tail -1 "$D/smoke-guard.log" | tee -a "$D/smokepair.log"
