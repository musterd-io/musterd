#!/usr/bin/env bash
# Cost-fix smoke (costfix-manifest.md): one pair per arm, dirty_equals 43 f2,f3, concurrently.
set -uo pipefail
source /etc/profile.d/cooperbench.sh
unset MUSTERD_ARM_LANE MUSTERD_ARM_LEAN
D=/data/runs/costfix-2026-11-06; mkdir -p "$D"; cd /data/runs
log() { echo "[$(date -u +%FT%TZ)] $*" | tee -a "$D/smoke.log"; }
M=claude-opus-5-5; T="-r samuelcolvin_dirty_equals_task -t 43 -f 2,3 -m $M --no-auto-eval"
log "smoke start: base, lean, solo ($M)"
cooperbench run -n costfix-smoke-base $T -a claude_code_musterd --setting coop --git > "$D/smoke-base.run.log" 2>&1 & P1=$!
MUSTERD_ARM_LEAN=1 cooperbench run -n costfix-smoke-lean $T -a claude_code_musterd --setting coop --git > "$D/smoke-lean.run.log" 2>&1 & P2=$!
cooperbench run -n costfix-smoke-solo $T -a claude_code --setting solo > "$D/smoke-solo.run.log" 2>&1 & P3=$!
wait $P1; log "base exit=$?"; wait $P2; log "lean exit=$?"; wait $P3; log "solo exit=$?"
for a in base lean solo; do cooperbench eval -n costfix-smoke-$a --backend docker > "$D/smoke-$a.eval.log" 2>&1; log "$a eval exit=$?"; done
for a in base lean solo; do
  for r in $(find /data/runs/logs/costfix-smoke-$a -name result.json); do
    d=$(dirname "$r")
    log "$a: $(python3 -c "import json,sys,glob,os
r=json.load(open(sys.argv[1])); d=os.path.dirname(sys.argv[1])
ev=json.load(open(d+'/eval.json')) if os.path.exists(d+'/eval.json') else {}
pats={os.path.basename(p):os.path.getsize(p) for p in glob.glob(d+'/*.patch')}
print('cost', round(r.get('total_cost') or 0,3), 'both_passed', ev.get('both_passed'), 'merge', (ev.get('merge') or {}).get('status'), 'patches', pats)" "$r")"
  done
done
for a in base lean; do
  log "$a init musterd tools: $(python3 -c "
import json,glob,sys
for f in glob.glob('/data/runs/logs/costfix-smoke-$a/**/*_stream.jsonl',recursive=True):
    for l in open(f):
        d=json.loads(l)
        if d.get('type')=='system' and d.get('subtype')=='init':
            print(f.rsplit('/',1)[1], len([t for t in d['tools'] if t.startswith('mcp__musterd__')]), end='; '); break")"
  log "$a lanes: $(grep -h -o 'lane_open' -r /data/runs/logs/costfix-smoke-$a 2>/dev/null | wc -l)"
done
touch "$D/smoke.done"
