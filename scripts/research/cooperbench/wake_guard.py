"""Stop a CooperBench act-lane run on wake spend while the pairs are still running.

Finding 031 (2026-11-04): one smoke pair spent $14.34 on wakes in 20 minutes and `spend_guard.py`
saw none of it, because it reads each pair's `result.json`, which a pair writes only when it ends.
Every pair's daemon prices its wakes as they settle (`residency.wake_cost` audit rows, ADR 252), in a
database on the run machine that is readable while the pair runs. This guard reads those.

    python3 wake_guard.py --pairs '/tmp/cb-musterd-*' --pair-cap 6 --total-cap 24.80 \\
        [--finished /data/runs/logs --runs 'r7b-*'] [--every 30] [--on-stop '<shell>']

- **pair**: the priced wake cost of every live pair (one daemon workdir each, `musterd.db` inside);
- **total**: those plus `spend_guard`'s read of the finished pairs' `result.json`, when `--finished`
  and `--runs` are given — so the overall hard stop counts wakes that no result has reported yet.
- Exit 3 on a breach after running `--on-stop` once (the same arm-killing command `run_arms.py`
  takes), 0 when the pair directories are gone and nothing is left to watch. Reads only; the daemon's
  files are opened read-only and copied nowhere.
"""

from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import spend_guard  # noqa: E402


def wake_cost_usd(db_path: Path) -> float:
    """Priced wakes in one pair daemon's database, summed; 0 when unreadable (never a guess)."""
    tmp = Path(tempfile.mkdtemp(prefix="wake-guard-"))
    try:
        # A live SQLite in WAL mode is read through a snapshot copy of the three files, so the
        # daemon's writer is never blocked and a half-written page is never read.
        for suffix in ("", "-wal", "-shm"):
            src = Path(str(db_path) + suffix)
            if src.exists():
                shutil.copy2(src, tmp / (db_path.name + suffix))
        con = sqlite3.connect(f"file:{tmp / db_path.name}?mode=ro", uri=True)
        try:
            total = 0.0
            for (detail,) in con.execute(
                "SELECT detail FROM audit WHERE action = 'residency.wake_cost'"
            ):
                try:
                    cost = json.loads(detail or "{}").get("cost_usd")
                except json.JSONDecodeError:
                    continue
                if isinstance(cost, (int, float)):
                    total += float(cost)
            return round(total, 4)
        finally:
            con.close()
    except (OSError, sqlite3.Error):
        return 0.0
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def check(pairs_glob: str, pair_cap: float, total_cap: float, finished_usd: float = 0.0) -> dict:
    pairs = {}
    for workdir in sorted(glob.glob(pairs_glob)):
        db = Path(workdir) / "musterd.db"
        if db.exists():
            pairs[workdir] = wake_cost_usd(db)
    live = round(sum(pairs.values()), 2)
    over_pair = [w for w, c in pairs.items() if c >= pair_cap]
    total = round(live + finished_usd, 2)
    stop = "pair_cap" if over_pair else ("total_cap" if total >= total_cap else None)
    return {
        "pairs": pairs,
        "live_wake_usd": live,
        "finished_usd": round(finished_usd, 2),
        "total_usd": total,
        "pair_cap": pair_cap,
        "total_cap": total_cap,
        "over_pair": over_pair,
        "stop": stop,
    }


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pairs", required=True, help="glob of live pair daemon workdirs (team.py mkdtemp)")
    ap.add_argument("--pair-cap", type=float, required=True, help="priced wake dollars one pair may reach")
    ap.add_argument("--total-cap", type=float, required=True, help="the manifest's hard stop, in dollars")
    ap.add_argument("--finished", type=Path, help="CooperBench logs dir, for spend_guard's finished read")
    ap.add_argument("--runs", help="run-name glob for the finished read (with --finished)")
    ap.add_argument("--every", type=float, default=30.0)
    ap.add_argument("--on-stop", help="shell command to run once on a breach")
    ap.add_argument("--once", action="store_true", help="one read, printed as JSON, no stop")
    a = ap.parse_args(argv)
    # The guard starts before the first pair's daemon exists (the arm stands it up after the task
    # image is pulled), so an empty glob means "not yet", not "done" — until a pair has been seen.
    # The first smoke pair of the re-run (2026-11-04 23:46Z) lost its guard to exactly that: one
    # empty read, exit 0, and the pair ran unguarded.
    seen_pairs = False
    while True:
        finished = (
            spend_guard.check(a.finished, a.runs, a.total_cap)["spent"] if a.finished and a.runs else 0.0
        )
        out = check(a.pairs, a.pair_cap, a.total_cap, finished)
        print(json.dumps(out), flush=True)
        if a.once:
            return 0
        if out["stop"]:
            if a.on_stop:
                subprocess.run(a.on_stop, shell=True, check=False)
            return 3
        if out["pairs"]:
            seen_pairs = True
        elif seen_pairs and not glob.glob(a.pairs):
            return 0
        time.sleep(a.every)


if __name__ == "__main__":
    sys.exit(main())
