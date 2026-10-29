"""Score the reviews and compute the manifest's statistic, its interval, and the pilot gate.

    python3 analyze.py --run <dir> --stage pilot|main [--main-reviews 750] [--cap-usd 200]

Hits are scored by script under both pre-registered rules (no judge):
  primary  a finding in the seeded file within 3 lines of the seeded site
  coarse   a finding in the seeded file inside the seeded diff hunk's new-file range
D = mean phi of the miss indicators over within-family reviewer pairs minus the mean over
cross-family pairs. A reviewer with no variance (misses every seeded item or none) has its pairs
dropped and reported. The 95% interval resamples features, 10,000 times, fixed seed.
"""

from __future__ import annotations

import argparse
import collections
import itertools
import json
import math
import random
from pathlib import Path

WINDOW = 3
RESAMPLES = 10_000
BOOT_SEED = 314
MIN_EFFECT = 0.15


def _same_file(finding_file: str, path: str) -> bool:
    f = finding_file.strip().lstrip("./")
    for prefix in ("a/", "b/"):
        if f.startswith(prefix):
            f = f[2:]
    return bool(f) and (f == path or path.endswith("/" + f) or f.endswith("/" + path))


def hit(findings: list[dict] | None, item: dict, rule: str) -> bool:
    if not findings:
        return False
    lo, hi = item["loc"] if rule == "primary" else item["hunk"]
    pad = WINDOW if rule == "primary" else 0
    for f in findings:
        if f.get("line") is None or not _same_file(f.get("file", ""), item["path"]):
            continue
        if lo - pad <= f["line"] <= hi + pad:
            return True
    return False


def phi(a: list[int], b: list[int]) -> float | None:
    n = len(a)
    if n == 0:
        return None
    pa, pb = sum(a) / n, sum(b) / n
    if pa in (0, 1) or pb in (0, 1):
        return None
    pab = sum(x & y for x, y in zip(a, b)) / n
    return (pab - pa * pb) / math.sqrt(pa * (1 - pa) * pb * (1 - pb))


def d_stat(miss: dict[str, list[int]], family: dict[str, str], idx: list[int]) -> tuple[float | None, list[str]]:
    """D over the item indices idx, and the reviewers dropped for having no variance."""
    cols = {m: [v[i] for i in idx] for m, v in miss.items()}
    live = [m for m, c in cols.items() if 0 < sum(c) < len(c)]
    dropped = sorted(set(cols) - set(live))
    within, cross = [], []
    for x, y in itertools.combinations(sorted(live), 2):
        p = phi(cols[x], cols[y])
        if p is None:
            continue
        (within if family[x] == family[y] else cross).append(p)
    if not within or not cross:
        return None, dropped
    return sum(within) / len(within) - sum(cross) / len(cross), dropped


def interval(miss, family, features: list[str]) -> tuple[float, float] | None:
    by_feature: dict[str, list[int]] = collections.defaultdict(list)
    for i, f in enumerate(features):
        by_feature[f].append(i)
    keys = sorted(by_feature)
    rng = random.Random(BOOT_SEED)
    ds = []
    for _ in range(RESAMPLES):
        idx = [i for k in (rng.choice(keys) for _ in keys) for i in by_feature[k]]
        d, _ = d_stat(miss, family, idx)
        if d is not None:
            ds.append(d)
    if len(ds) < RESAMPLES // 2:
        return None
    ds.sort()
    return ds[int(0.025 * len(ds))], ds[int(0.975 * len(ds)) - 1]


def stage_spend(reviews) -> float:
    return sum((r.get("cost_usd") or 0) for r in reviews)


def projected_total(pilot_reviews: list[dict], main_reviews: int) -> float:
    """The manifest's re-ask figure: pilot spend plus its mean cost per review times the main run."""
    spent = stage_spend(pilot_reviews)
    return spent + spent / max(1, len(pilot_reviews)) * main_reviews


def verdict(primary: tuple | None, coarse: tuple | None) -> str:
    def one(ci):
        if ci is None:
            return "inconclusive"
        lo, hi = ci
        if lo > 0:
            return "same-family excess"
        if hi < MIN_EFFECT:
            return "no excess worth routing on"
        return "inconclusive"

    a, b = one(primary), one(coarse)
    return a if a == b else "inconclusive (rules disagree)"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", type=Path, required=True)
    ap.add_argument("--stage", choices=["pilot", "main"], required=True)
    ap.add_argument("--main-reviews", type=int, default=750)
    ap.add_argument("--cap-usd", type=float, default=200.0)
    a = ap.parse_args()

    items = {i["item"]: i for i in map(json.loads, open(a.run / "items.jsonl")) if i["stage"] == a.stage}
    reviews = [r for r in map(json.loads, open(a.run / "reviews.jsonl")) if r["stage"] == a.stage]
    family = {r["model"]: r["family"] for r in reviews}
    models = sorted(family)
    by = {(r["item"], r["model"]): r for r in reviews}
    seeded = sorted(k for k, i in items.items() if i["class"] != "control")
    controls = sorted(k for k, i in items.items() if i["class"] == "control")

    report: dict = {"stage": a.stage, "items": len(items), "seeded": len(seeded), "controls": len(controls)}
    report["json_ok"] = {
        m: sum(1 for k in items if by.get((k, m), {}).get("findings") is not None) for m in models
    }
    report["false_alarms"] = {
        m: sum(1 for k in controls if (by.get((k, m), {}).get("findings") or [])) for m in models
    }
    spent = stage_spend(reviews)  # this stage's rows only, so the pilot gate reads the same after main runs
    report["spent_usd"] = round(spent, 2)
    report["spent_all_stages_usd"] = round(stage_spend(map(json.loads, open(a.run / "reviews.jsonl"))), 2)

    for rule in ("primary", "coarse"):
        miss = {m: [0 if hit(by.get((k, m), {}).get("findings"), items[k], rule) else 1 for k in seeded] for m in models}
        n = len(seeded) * len(models)
        report[f"miss_rate_{rule}"] = round(sum(map(sum, miss.values())) / n, 3) if n else None
        report[f"miss_by_model_{rule}"] = {m: sum(v) for m, v in miss.items()}
        d, dropped = d_stat(miss, family, list(range(len(seeded))))
        report[f"D_{rule}"] = None if d is None else round(d, 3)
        report[f"dropped_{rule}"] = dropped
        if a.stage == "main":
            ci = interval(miss, family, [items[k]["feature"] for k in seeded])
            report[f"ci_{rule}"] = None if ci is None else [round(ci[0], 3), round(ci[1], 3)]

    if a.stage == "pilot":
        json_ok = all(v >= 9 for v in report["json_ok"].values()) and len(items) >= 10
        rate = report["miss_rate_primary"]
        band = rate is not None and 0.20 <= rate <= 0.80
        projected = projected_total(reviews, a.main_reviews)
        report["pilot_gate"] = {
            "json_shape_9_of_10": json_ok,
            "miss_rate_in_20_80": band,
            "projected_total_usd": round(projected, 2),
            "within_cap": projected <= a.cap_usd,
            "pass": json_ok and band and projected <= a.cap_usd,
        }
    else:
        report["verdict"] = verdict(
            tuple(report["ci_primary"]) if report.get("ci_primary") else None,
            tuple(report["ci_coarse"]) if report.get("ci_coarse") else None,
        )
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
