"""The keep step: run each candidate mutant against its feature's tests, on the CooperBench machine.

    python3 keep.py --dataset /opt/cooperbench/dataset --run <dir> [-c 6] [--task <repo>/task<N>]
    sh keep_all.sh <dir>     # every task in turn, pulling and then removing images the disk lacks

Reads <dir>/candidates.jsonl and <dir>/candidates/*.patch (from `items.py seed`), and appends one
row per candidate to <dir>/kept.jsonl. Resumable: a candidate already in kept.jsonl is skipped.

The rule is the manifest's: CooperBench's own `run_patch_test` (solo, one patch against the
feature's tests). The unmutated reference must pass, once per feature. A mutant is kept when it
fails at least one test and passes at least one. An evaluator error drops it. No model is called.
"""

from __future__ import annotations

import argparse
import json
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def _test(dataset: Path, feature: str, patch: Path | None) -> dict:
    from cooperbench.eval.sandbox import run_patch_test  # only on the run machine

    repo, task, feat = feature.split("/")
    r = run_patch_test(
        repo,
        int(task.removeprefix("task")),
        int(feat.removeprefix("feature")),
        agent_patch=patch,
        backend="docker",
        dataset_dir=dataset,
    )
    return {k: r.get(k) for k in ("passed", "tests_passed", "tests_failed", "error")}


def verdict(ref: dict, mut: dict) -> tuple[bool, str]:
    if ref.get("error") or not ref.get("passed"):
        return False, "reference does not pass"
    if mut.get("error"):
        return False, f"evaluator error: {str(mut['error'])[:120]}"
    if not mut.get("tests_failed"):
        return False, "no test fails (mutant survives)"
    if not mut.get("tests_passed"):
        return False, "no test passes (breaks the suite)"
    return True, "kept"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", type=Path, required=True)
    ap.add_argument("--run", type=Path, required=True)
    ap.add_argument("-c", type=int, default=6)
    ap.add_argument("--task", help="only this <repo>/task<N> (keep_all.sh runs one task at a time)")
    a = ap.parse_args()

    cands = [json.loads(l) for l in open(a.run / "candidates.jsonl") if l.strip()]
    out_path = a.run / "kept.jsonl"
    done = {json.loads(l)["id"] for l in open(out_path)} if out_path.exists() else set()
    todo = [c for c in cands if c["id"] not in done]
    if a.task:
        todo = [c for c in todo if c["feature"].startswith(a.task + "/")]
    print(f"{len(cands)} candidates, {len(done)} already done, {len(todo)} to run", flush=True)

    refs: dict[str, dict] = {}
    ref_lock = threading.Lock()
    write_lock = threading.Lock()
    started = time.time()

    def reference(feature: str) -> dict:
        with ref_lock:
            if feature in refs:
                return refs[feature]
        r = _test(a.dataset, feature, None)
        with ref_lock:
            refs[feature] = r
        return r

    def one(c: dict) -> None:
        ref = reference(c["feature"])
        mut = _test(a.dataset, c["feature"], a.run / "candidates" / f"{c['id']}.patch") if ref.get("passed") else {}
        keep, why = verdict(ref, mut)
        row = {**c, "keep": keep, "why": why, "reference": ref, "mutant": mut}
        with write_lock:
            with open(out_path, "a") as f:
                f.write(json.dumps(row) + "\n")
            print(f"{'KEEP' if keep else 'drop'}\t{c['id']}\t{why}", flush=True)

    with ThreadPoolExecutor(a.c) as ex:
        list(ex.map(one, todo))
    print(f"done in {(time.time() - started) / 3600:.2f} h", flush=True)


if __name__ == "__main__":
    main()
