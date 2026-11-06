#!/usr/bin/env python3
"""Cost-fix K3 read (costfix-manifest.md, as amended): seed 2 of finding 035's C1 — musterd baseline vs
solo on the 50 flash pairs, exact two-sided McNemar on CooperBench's `both_passed`. Seed 1 (finding 035)
is read beside it with the same code.

usage: k3read.py <seed-2 logs> <seed-1 logs> [--json out]
"""
import glob, json, math, os, sys


def arm(logs, run, setting):
    out = {}
    for f in glob.glob(os.path.join(logs, run, setting, "*", "*", "*", "eval.json")):
        d = os.path.dirname(f)
        key = "/".join(d.split(os.sep)[-3:])
        r = json.load(open(os.path.join(d, "result.json")))
        e = json.load(open(f))
        out[key] = {"pass": bool(e.get("both_passed")), "cost": r.get("total_cost") or 0.0,
                    "merge": (e.get("merge") or {}).get("status")}
    return out


def mcnemar(b, c):
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    p = sum(math.comb(n, i) for i in range(0, k + 1)) / 2 ** n
    return min(1.0, 2 * p)


def wilson(x, n, z=1.959964):
    p = x / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return round(c - h, 3), round(c + h, 3)


def read(m, s, label):
    keys = sorted(set(m) & set(s))
    assert len(keys) == 50, (label, len(keys), len(m), len(s))
    mp = sum(m[k]["pass"] for k in keys); sp = sum(s[k]["pass"] for k in keys)
    b = sum(1 for k in keys if m[k]["pass"] and not s[k]["pass"])
    c = sum(1 for k in keys if s[k]["pass"] and not m[k]["pass"])
    p = mcnemar(b, c)
    verdict = ("musterd better" if b > c else "solo better") if p < 0.05 else "no detectable difference at N = 50"
    mc = sum(m[k]["cost"] for k in keys); sc = sum(s[k]["cost"] for k in keys)
    merges = {}
    for k in keys:
        merges[m[k]["merge"]] = merges.get(m[k]["merge"], 0) + 1
    return {"label": label, "musterd_pass": mp, "solo_pass": sp, "musterd_only": b, "solo_only": c, "p": p,
            "verdict": verdict, "musterd_wilson": wilson(mp, 50), "solo_wilson": wilson(sp, 50),
            "musterd_cost": round(mc, 2), "solo_cost": round(sc, 2), "cost_ratio": round(mc / sc, 2),
            "musterd_per_pass": round(mc / mp, 3) if mp else None, "solo_per_pass": round(sc / sp, 3) if sp else None,
            "musterd_merge": merges,
            "musterd_only_pairs": [k for k in keys if m[k]["pass"] and not s[k]["pass"]],
            "solo_only_pairs": [k for k in keys if s[k]["pass"] and not m[k]["pass"]]}, keys


L2, L1 = sys.argv[1], sys.argv[2]
m1 = arm(L1, "flash2-musterd", "coop"); m1.update(arm(L1, "flash2r-musterd", "coop"))
s1 = arm(L1, "flash2-solo", "solo")
m2 = arm(L2, "costfix2-base", "coop"); s2 = arm(L2, "costfix2-solo", "solo")
r2, keys = read(m2, s2, "seed 2 (K3)")
r1, _ = read(m1, s1, "seed 1 (finding 035 C1)")
# Across seeds, per arm: how many pairs flipped.
flip = {"musterd": sum(m1[k]["pass"] != m2[k]["pass"] for k in keys), "solo": sum(s1[k]["pass"] != s2[k]["pass"] for k in keys)}
pooled_b = r1["musterd_only"] + r2["musterd_only"]; pooled_c = r1["solo_only"] + r2["solo_only"]
out = {"K3": r2, "seed1": r1, "flips_between_seeds": flip,
       "descriptive_pooled_discordant": [pooled_b, pooled_c]}
print(json.dumps(out, indent=1))
if len(sys.argv) > 4 and sys.argv[3] == "--json":
    json.dump(out, open(sys.argv[4], "w"), indent=1)
