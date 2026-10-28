"""Seed candidate mutants, then draw the study's items from the ones the keep step kept.

    python3 items.py seed --dataset <cooperbench>/dataset --out <dir>       # candidates/*.patch + candidates.jsonl
    python3 items.py topup --dataset <cooperbench>/dataset --out <dir>      # appends every site `seed` skipped
    python3 items.py draw --dataset <cooperbench>/dataset --out <dir>       # needs <dir>/kept.jsonl; writes items.jsonl

All steps are deterministic under SEED. `seed` takes at most two sites per (feature, class), so
the first keep pass evaluates a few hundred mutants, not every site. `topup` appends the sites
`seed` left out, under new ids, so a second keep pass resumes over them. `draw` applies the
manifest's rules: at most three items per feature and two per class within a feature, classes as
even as the kept pool allows, the first PILOT items as the pilot, and one control per four seeded
items from features with no item.
"""

from __future__ import annotations

import argparse
import collections
import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import mutate  # noqa: E402
import patchlib  # noqa: E402

FIRST_SEED = 20261027  # the first operator set's seed (pilot 1); see mutate.FIRST_CLASSES
SEED = 20261028  # the second set's, after the kill rule's one operator change
PER_FEATURE_CLASS = 2
DRAW_PER_FEATURE = 3
DRAW_PER_FEATURE_CLASS = 2
MAIN = 100
PILOT_SEEDED = 8
PILOT_CONTROLS = 2


def feature_key(patch_path: Path) -> str:
    """`<repo>/task<N>/feature<M>` for a dataset feature.patch path."""
    return "/".join(patch_path.parts[-4:-1])


def python_features(dataset: Path) -> list[Path]:
    out = []
    for p in sorted(dataset.glob("*/task*/feature*/feature.patch")):
        if any(f.is_python_source for f in patchlib.parse(p.read_text())):
            out.append(p)
    return out


def seed(dataset: Path, out: Path) -> list[dict]:
    rng = random.Random(SEED)
    (out / "candidates").mkdir(parents=True, exist_ok=True)
    rows = []
    for p in python_features(dataset):
        files = patchlib.parse(p.read_text())
        by_class: dict[str, list[mutate.Site]] = collections.defaultdict(list)
        for s in mutate.sites(files):
            by_class[s.cls].append(s)
        for cls in mutate.CLASSES:
            pool = by_class.get(cls, [])
            for site in rng.sample(pool, min(PER_FEATURE_CLASS, len(pool))):
                rows.append(_row(out, len(rows), p, cls, site, mutate.apply(files, site)))
    with open(out / "candidates.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return rows


def _row(out: Path, n: int, p: Path, cls: str, site: mutate.Site, m: mutate.Mutant) -> dict:
    cid = f"{feature_key(p).replace('/', '__')}__{cls}__{n:04d}"
    (out / "candidates" / f"{cid}.patch").write_text(m.patch)
    return {
        "id": cid,
        "feature": feature_key(p),
        "class": cls,
        "detail": site.detail,
        "path": m.path,
        "loc": [m.loc_start, m.loc_end],
        "hunk": list(m.hunk_range),
    }


def topup(dataset: Path, out: Path) -> list[dict]:
    """Append every site `seed` did not take. Existing ids and patches are left as they are."""
    rows = [json.loads(l) for l in open(out / "candidates.jsonl") if l.strip()]
    have = {(r["feature"], (out / "candidates" / f"{r['id']}.patch").read_text()) for r in rows}
    added = []
    for p in python_features(dataset):
        files = patchlib.parse(p.read_text())
        for site in mutate.sites(files):
            m = mutate.apply(files, site)
            if (feature_key(p), m.patch) in have:
                continue
            have.add((feature_key(p), m.patch))
            added.append(_row(out, len(rows) + len(added), p, site.cls, site, m))
    with open(out / "candidates.jsonl", "a") as f:
        for r in added:
            f.write(json.dumps(r) + "\n")
    return added


def draw(dataset: Path, out: Path) -> list[dict]:
    rng = random.Random(SEED + 1)
    kept = [json.loads(l) for l in open(out / "kept.jsonl") if l.strip()]
    kept = [k for k in kept if k.get("keep")]
    pool: dict[str, list[dict]] = collections.defaultdict(list)
    for k in sorted(kept, key=lambda k: k["id"]):
        pool[k["class"]].append(k)
    for cls in pool:
        rng.shuffle(pool[cls])

    used: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)  # feature -> class -> n
    seeded: list[dict] = []
    want = MAIN + PILOT_SEEDED
    progress = True
    while len(seeded) < want and progress:
        progress = False
        for cls in mutate.CLASSES:  # round-robin: as even as the pool allows
            if len(seeded) >= want:
                break
            while pool.get(cls):
                k = pool[cls].pop()
                f = k["feature"]
                if sum(used[f].values()) < DRAW_PER_FEATURE and used[f][cls] < DRAW_PER_FEATURE_CLASS:
                    used[f][cls] += 1
                    seeded.append(k)
                    progress = True
                    break
    if len(seeded) < want:
        raise SystemExit(f"only {len(seeded)} seeded items drawable from the kept pool; the manifest needs {want}")

    controls_pool = [feature_key(p) for p in python_features(dataset) if feature_key(p) not in used]
    rng.shuffle(controls_pool)
    n_controls = MAIN // 4 + PILOT_CONTROLS
    if len(controls_pool) < n_controls:
        raise SystemExit(f"only {len(controls_pool)} unseeded features for {n_controls} controls")

    pilot = seeded[:PILOT_SEEDED] + [{"feature": f, "class": "control"} for f in controls_pool[:PILOT_CONTROLS]]
    main = seeded[PILOT_SEEDED:] + [{"feature": f, "class": "control"} for f in controls_pool[PILOT_CONTROLS:n_controls]]
    rows = []
    for stage, items in (("pilot", pilot), ("main", main)):
        rng.shuffle(items)  # the run order, fixed by seed
        for i, it in enumerate(items):
            rows.append({**it, "stage": stage, "order": i, "item": it.get("id") or f"control__{it['feature'].replace('/', '__')}"})
    with open(out / "items.jsonl", "w") as f:
        for r in rows:
            f.write(json.dumps(r) + "\n")
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("step", choices=["seed", "topup", "draw"])
    ap.add_argument("--dataset", type=Path, required=True)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    rows = {"seed": seed, "topup": topup, "draw": draw}[a.step](a.dataset, a.out)
    counts = collections.Counter((r.get("stage", "candidate"), r["class"]) for r in rows)
    for k in sorted(counts):
        print(*k, counts[k], sep="\t")


if __name__ == "__main__":
    main()
