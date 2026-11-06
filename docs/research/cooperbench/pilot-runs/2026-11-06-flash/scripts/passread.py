"""Flash comparison reader: one row per pair per arm — passed (both features), merge, cost, patch bytes."""
import json, glob, os, sys
root = sys.argv[1]
flash = json.load(open('/data/runs/dataset/subsets/flash.json'))
pairs = [(t['repo'], t['task_id'], tuple(sorted(p))) for t in flash['tasks'] for p in t['pairs']]
out = {}
for arm, setting in (('solo', 'solo'), ('team', 'team'), ('musterd', 'coop')):
    rows = {}
    for repo, tid, (a, b) in pairs:
        d = f"{root}/flash2-{arm}/{setting}/{repo}/{tid}/f{a}_f{b}"
        r = {}
        rf = os.path.join(d, 'result.json')
        if os.path.exists(rf):
            res = json.load(open(rf)); r['cost'] = round(float(res.get('total_cost') or 0), 3)
            ag = res.get('agents') or ({'solo': res.get('agent')} if res.get('agent') else {})
            r['status'] = sorted({(v or {}).get('status') for v in ag.values() if isinstance(v, dict)})
        ev = None
        for e in sorted(glob.glob(os.path.join(d, 'eval*.json'))):
            try: ev = json.load(open(e)); break
            except Exception: pass
        if ev is not None:
            r['passed'] = bool(ev.get('both_passed')); r['merge'] = (ev.get('merge') or {}).get('status')
            r['f1'] = (ev.get('feature1') or {}).get('passed'); r['f2'] = (ev.get('feature2') or {}).get('passed')
        r['patch_bytes'] = sum(os.path.getsize(p) for p in glob.glob(os.path.join(d, '*.patch')))
        rows[f"{repo}/{tid}/f{a}_f{b}"] = r
    out[arm] = rows
json.dump(out, sys.stdout, indent=1)
