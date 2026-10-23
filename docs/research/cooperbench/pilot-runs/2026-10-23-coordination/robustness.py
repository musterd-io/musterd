"""Finding 023's robustness checks, on data already in the repo (lane 01M5KHD19K, 2026-10-23, $0).

1. Errored pairs excluded instead of counted as no conflict.
2. Which files the conflicts are on.
3. How often each arm's two agents submitted byte-identical patches.

Usage, from the repo root:
  python3 docs/research/cooperbench/pilot-runs/2026-10-23-coordination/robustness.py
"""

from __future__ import annotations

import json
from math import comb
from pathlib import Path

HERE = Path(__file__).resolve().parent
COORD = json.loads((HERE / "readout.json").read_text())
CLAIM = json.loads((HERE.parent / "2026-10-22-claim" / "readout.json").read_text())
NEW = {t["repo"] + "/" + str(t["task_id"]) for t in json.loads((HERE.parents[1] / "claim20.json").read_text())["new"]}


def fisher_le(a: int, n1: int, b: int, n2: int) -> float:
    """One-sided Fisher's exact test: P(musterd conflicts <= a | margins)."""
    k, n = a + b, n1 + n2
    return sum(comb(k, x) * comb(n - k, n1 - x) for x in range(0, a + 1)) / comb(n, n1)


def conflicted(p: dict) -> bool:
    return p["merge"] == "conflicts" and bool(p["common_files"])


def main() -> None:
    mus = [p for p in CLAIM["pairs"] if "musterd" in (p["arm"] or "") and p["task"] in NEW]
    m = sum(conflicted(p) for p in mus)
    print(f"musterd: {m}/{len(mus)} conflicted, {sum(p['merge'] == 'identical' for p in mus)}/{len(mus)} identical patches")
    for setting in ("team", "coop"):
        ps = [p for p in COORD["pairs"] if p["setting"] == setting]
        clean = [p for p in ps if not any(v == "Error" for v in (p["agent_status"] or {}).values())]
        c_all = sum(conflicted(p) for p in ps)
        # Pre-registered reading: an errored pair counts as no conflict, so only clean pairs' conflicts
        # count, out of 10. The second reading leaves the errored pairs out of the denominator too.
        c_clean = c_as_run = sum(conflicted(p) for p in clean)
        print(
            f"{setting}: as pre-registered {c_as_run}/10 (p = {fisher_le(m, len(mus), c_as_run, 10):.4f}); "
            f"errored pairs excluded {c_clean}/{len(clean)} (p = {fisher_le(m, len(mus), c_clean, len(clean)):.4f}); "
            f"all pairs incl. errored {c_all}/10; identical patches {sum(p['merge'] == 'identical' for p in ps)}/10"
        )
        for p in ps:
            if conflicted(p):
                print(f"    {p['task']}: {', '.join(p['common_files'])}")


if __name__ == "__main__":
    main()
