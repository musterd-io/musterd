#!/usr/bin/env bash
cd /data/runs/logs 2>/dev/null || exit 0
python3 - <<'PY'
import json,glob,time
tot=0; parts=[]
for a,n in (('solo',50),('team',50),('musterd',50)):
    fs=glob.glob(f'flash2-{a}/**/result.json', recursive=True)
    c=0.0; err=0
    for f in fs:
        try:
            r=json.load(open(f)); c+=float(r.get('total_cost') or 0)
            ag=r.get('agents') or {}
            if isinstance(ag,dict) and any(isinstance(v,dict) and v.get('status')=='Error' for v in ag.values()): err+=1
            a1=r.get('agent')
            if isinstance(a1,dict) and a1.get('status')=='Error': err+=1
        except Exception: pass
    tot+=c
    parts.append(f"{a} {len(fs)}/{n} ${c:.2f}" + (f" err={err}" if err else ""))
lim=sum(1 for s in glob.glob('flash2-*/**/*_stream.jsonl', recursive=True) if 'usage limit' in open(s,errors='replace').read().lower())
import shutil
free=shutil.disk_usage('/data').free/1e9
print(time.strftime('%H:%MZ',time.gmtime()), ' · '.join(parts), f"· total ${tot:.2f} · /data {free:.0f}G free" + (f" · API-LIMIT lines {lim}" if lim else ""))
PY
grep -E "STOP|run_arms exit=|PULL FAILED|all done" /data/runs/flash-2026-11-06/flash2.log 2>/dev/null | tail -2 || true
ls /data/runs/flash-2026-11-06/all.done 2>/dev/null && echo ALL-DONE
