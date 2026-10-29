import json, collections, statistics, sys, itertools
sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parents[3] / "scripts/research/family-correlation"))
import analyze as A
run = sys.argv[1]
items = {i["item"]: i for i in map(json.loads, open(f"{run}/items.jsonl")) if i["stage"] == "main"}
reviews = [r for r in map(json.loads, open(f"{run}/reviews.jsonl")) if r["stage"] == "main"]
fam = {r["model"]: r["family"] for r in reviews}; models = sorted(fam)
by = {(r["item"], r["model"]): r for r in reviews}
seeded = sorted(k for k, i in items.items() if i["class"] != "control")
spans = [items[k]["hunk"][1] - items[k]["hunk"][0] + 1 for k in seeded]
print("hunk span median", statistics.median(spans), "max", max(spans), "p75", sorted(spans)[75])
feats = collections.Counter(items[k]["feature"] for k in seeded)
print("features", len(feats), "largest", max(feats.values()), collections.Counter(feats.values()))
print("classes", collections.Counter(items[k]["class"] for k in seeded))
hits = {rule: {m: sum(A.hit(by.get((k, m), {}).get("findings"), items[k], rule) for k in seeded) for m in models} for rule in ("primary","coarse")}
for f in sorted(set(fam.values())):
    ms = [m for m in models if fam[m] == f]
    p = sum(hits["primary"][m] for m in ms) / (len(ms)*len(seeded)); c = sum(hits["coarse"][m] for m in ms)/(len(ms)*len(seeded))
    print("family", f, "primary hit", round(p,3), "coarse hit", round(c,3), "gap", round(c-p,3))
for rule in ("primary","coarse"):
    miss = {m: [0 if A.hit(by.get((k, m), {}).get("findings"), items[k], rule) else 1 for k in seeded] for m in models}
    for cls in sorted({items[k]["class"] for k in seeded}):
        idx = [i for i,k in enumerate(seeded) if items[k]["class"] == cls]
        d, dr = A.d_stat(miss, fam, idx)
        rate = sum(miss[m][i] for m in models for i in idx)/(len(idx)*len(models))
        print(rule, cls, "n", len(idx), "miss", round(rate,3), "D", None if d is None else round(d,3), "dropped", dr)
    # within / cross means
    w=[];c=[]
    for x,y in itertools.combinations(models,2):
        p=A.phi(miss[x],miss[y])
        if p is None: continue
        (w if fam[x]==fam[y] else c).append(p)
    print(rule, "within mean", round(sum(w)/len(w),3), [round(v,3) for v in w], "cross mean", round(sum(c)/len(c),3))
    allmiss = sum(1 for i in range(len(seeded)) if all(miss[m][i] for m in models))
    print(rule, "missed by all six", allmiss)
print("served", sorted({(r["model"], r.get("served_model"), r.get("temperature")) for r in reviews}))
print("fa rate per model", {m: round(v/25,2) for m,v in {m: sum(1 for k in items if items[k]['class']=='control' and (by.get((k,m),{}).get('findings') or [])) for m in models}.items()})
