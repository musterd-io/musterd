"""Finding 035 reader (flash-manifest.md): per-pair pass for solo, team, musterd (composite: the one
errored pair from its re-run), exact two-sided McNemar for C1–C3, Wilson intervals, cost, merge."""
import json, glob, os, sys, math, collections
from math import comb
root, flash = sys.argv[1], json.load(open(sys.argv[2]))
pairs = [(t['repo'], t['task_id'], tuple(sorted(p))) for t in flash['tasks'] for p in t['pairs']]
def row(run, setting, repo, tid, a, b):
    d = f"{root}/logs/{run}/{setting}/{repo}/{tid}/f{a}_f{b}"
    rf = os.path.join(d, 'result.json')
    if not os.path.exists(rf): return None
    res = json.load(open(rf)); ev = None
    for e in sorted(glob.glob(os.path.join(d, 'eval*.json'))):
        try: ev = json.load(open(e)); break
        except Exception: pass
    return {'passed': bool(ev and ev.get('both_passed')), 'eval': ev is not None,
            'merge': ((ev or {}).get('merge') or {}).get('status'),
            'cost': float(res.get('total_cost') or 0), 'dur': float(res.get('duration_seconds') or 0),
            'patch': sum(os.path.getsize(p) for p in glob.glob(os.path.join(d, '*.patch')))}
arms = {}
for arm, run, setting in (('solo','flash2-solo','solo'),('team','flash2-team','team'),('musterd','flash2-musterd','coop')):
    arms[arm] = {}
    for repo, tid, (a, b) in pairs:
        r = row(run, setting, repo, tid, a, b)
        if r is None and arm == 'musterd': r = row('flash2r-musterd', 'coop', repo, tid, a, b); 
        arms[arm][f"{repo}/{tid}/f{a}_f{b}"] = r
def wilson(k, n, z=1.96):
    p = k/n; d = 1+z*z/n; c = p + z*z/(2*n); h = z*math.sqrt(p*(1-p)/n + z*z/(4*n*n))
    return (c-h)/d, (c+h)/d
def mcnemar(x, y):
    b = sum(1 for k in x if x[k]['passed'] and not y[k]['passed']); c = sum(1 for k in x if y[k]['passed'] and not x[k]['passed'])
    n = b + c
    if n == 0: return b, c, 1.0
    p = 2*sum(comb(n, i) for i in range(0, min(b, c)+1))/2**n
    return b, c, min(1.0, p)
out = {'pairs': len(pairs), 'arms': {}, 'tests': {}, 'per_pair': {}}
for arm, rows in arms.items():
    assert all(r is not None and r['eval'] for r in rows.values()), (arm, [k for k,r in rows.items() if not r or not r['eval']])
    k = sum(r['passed'] for r in rows.values()); n = len(rows); lo, hi = wilson(k, n)
    cost = sum(r['cost'] for r in rows.values())
    out['arms'][arm] = {'passed': k, 'n': n, 'rate': round(k/n, 3), 'wilson95': [round(lo,3), round(hi,3)],
        'cost_usd': round(cost, 2), 'usd_per_pair': round(cost/n, 3), 'usd_per_pass': round(cost/k, 3) if k else None,
        'median_wall_s': round(sorted(r['dur'] for r in rows.values())[n//2]),
        'merge': dict(collections.Counter(r['merge'] for r in rows.values())),
        'empty_patch_pairs': sum(1 for r in rows.values() if r['patch'] == 0)}
for name, x, y in (('C1 musterd vs solo','musterd','solo'),('C2 musterd vs team','musterd','team'),('C3 team vs solo','team','solo')):
    b, c, p = mcnemar(arms[x], arms[y])
    out['tests'][name] = {f'{x}_only': b, f'{y}_only': c, 'p_exact_two_sided': round(p, 6),
        'verdict': (f'{x} better' if b > c else f'{y} better') if p < 0.05 else 'no detectable difference at N = 50',
        'point_difference_pairs': out['arms'][x]['passed'] - out['arms'][y]['passed']}
for k in arms['solo']:
    out['per_pair'][k] = {a: int(arms[a][k]['passed']) for a in arms}
json.dump(out, sys.stdout, indent=1)
