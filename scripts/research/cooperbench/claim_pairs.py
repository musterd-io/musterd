"""Draw the claim run's 10 new pairs and write the 20-pair subset (claim-manifest.md, Tasks).

The tasks in CooperBench's `all.json` that no `core.json` pair uses; with `random.Random(20261022)`,
sample 10 of them (sorted), then one pair from each. Output is a subset file in CooperBench's own
format (`dataset/subsets/<name>.json`), core's ten first.

Usage: python3 claim_pairs.py <dataset/subsets dir> > claim20.json
"""

import json
import random
import sys
from pathlib import Path

SEED = 20261022
NEW = 10


def pairs(subset: dict) -> list[tuple[str, int, tuple[int, int]]]:
    return [
        (t["repo"], int(t["task_id"]), tuple(p))
        for t in subset["tasks"]
        for p in t["pairs"]
    ]


def main() -> None:
    d = Path(sys.argv[1])
    core = pairs(json.loads((d / "core.json").read_text()))
    # One pair per task, from tasks core does not use: a uniform draw over pairs lands several on
    # one task (tiktoken task 0 alone has 45), and pairs on one task are not independent.
    core_tasks = {(r, t) for r, t, _ in core}
    by_task: dict[tuple[str, int], list[tuple[int, int]]] = {}
    for repo, task, p in sorted(pairs(json.loads((d / "all.json").read_text()))):
        if (repo, task) in core_tasks:
            continue
        by_task.setdefault((repo, task), []).append(p)
    rng = random.Random(SEED)
    new = [(r, t, rng.choice(by_task[(r, t)])) for r, t in rng.sample(sorted(by_task), NEW)]
    tasks: dict[tuple[str, int], list[list[int]]] = {}
    for repo, task, p in core + new:
        tasks.setdefault((repo, task), []).append(list(p))
    json.dump(
        {
            "name": "claim20",
            "description": f"core (10) + {NEW} tasks core does not use, one pair each, "
            f"random.Random({SEED}) (musterd claim-manifest.md)",
            "new": [{"repo": r, "task_id": t, "pair": list(p)} for r, t, p in new],
            "tasks": [{"repo": r, "task_id": t, "pairs": ps} for (r, t), ps in tasks.items()],
        },
        sys.stdout,
        indent=2,
    )
    print()


if __name__ == "__main__":
    main()
