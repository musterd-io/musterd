#!/usr/bin/env bash
# CooperBench flash comparison step 2 (flash-manifest.md): one smoke pair per arm, concurrently.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
unset MUSTERD_ARM_LANE
D=/data/runs/flash-2026-11-06; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/smoke.log"; }
docker pull -q akhatua/cooperbench-samuelcolvin-dirty-equals:task43 >> "$D/pull.log" 2>&1 || log "PULL FAILED dirty-equals:task43"
M=claude-opus-5-5; T="-r samuelcolvin_dirty_equals_task -t 43 -f 2,3 -m $M --no-auto-eval"
log "smoke start: solo, team, musterd on dirty_equals 43 f2,f3 ($M)"
cooperbench run -n flash-smoke-solo $T -a claude_code --setting solo > "$D/smoke-solo.run.log" 2>&1 & P1=$!
cooperbench run -n flash-smoke-team $T -a claude_code --setting team > "$D/smoke-team.run.log" 2>&1 & P2=$!
cooperbench run -n flash-smoke-musterd $T -a claude_code_musterd --setting coop --git > "$D/smoke-musterd.run.log" 2>&1 & P3=$!
wait $P1; log "solo run exit=$?"; wait $P2; log "team run exit=$?"; wait $P3; log "musterd run exit=$?"
for a in solo team musterd; do cooperbench eval -n flash-smoke-$a --backend docker > "$D/smoke-$a.eval.log" 2>&1; log "$a eval exit=$?"; done
for a in solo team musterd; do
  for r in $(find /data/runs/logs/flash-smoke-$a -name result.json); do
    d=$(dirname "$r")
    log "$a: $(python3 -c "import json,sys,glob,os
r=json.load(open(sys.argv[1])); d=os.path.dirname(sys.argv[1])
ev={}
for e in glob.glob(d+'/eval*.json'):
    try: ev=json.load(open(e)); break
    except Exception: pass
ag=r.get('agents') or {}
st={k:(v.get('status') if isinstance(v,dict) else v) for k,v in (ag.items() if isinstance(ag,dict) else [])}
pats={os.path.basename(p):os.path.getsize(p) for p in glob.glob(d+'/*.patch')+glob.glob(d+'/*patch*.txt')}
print('cost', round(r.get('total_cost') or 0,3), 'status', st, 'both_passed', ev.get('both_passed'), 'f1', (ev.get('feature1') or {}).get('passed'), 'f2', (ev.get('feature2') or {}).get('passed'), 'merge', (ev.get('merge') or {}).get('status'), 'patches', pats)" "$r")"
  done
done
log "team harness evidence: $(grep -l -iE 'scratchpad|task.list|coop-task' -r /data/runs/logs/flash-smoke-team 2>/dev/null | head -3 | tr '\n' ' ')"
log "musterd evidence: $(grep -h -o 'lane_claim\|lane_open' -r /data/runs/logs/flash-smoke-musterd 2>/dev/null | sort | uniq -c | tr '\n' ' ')"
touch "$D/smoke.done"
