"""run_arms.py stops every arm when spend_guard says stop, and evaluates only arms that finished
(lane 01M5KHD19K). Fake arms are shell loops, and spend appears as result.json files written into
the logs folder, the way a CooperBench pair writes its own.

Runs under pytest, or as `python3 tests/test_run_arms.py` where pytest is not installed.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import run_arms  # noqa: E402

LIMIT = '{"type":"result","result":"API Error: 400 You have reached your specified API usage limits."}'


def write_pair(logs: Path, run: str, pair: str, cost: float, stream: str = "{}") -> str:
    d = logs / run / pair
    return f"mkdir -p {d} && printf '%s\\n' '{stream}' > {d}/agent1_stream.jsonl && echo '{json.dumps({'total_cost': cost})}' > {d}/result.json"


def test_a_hard_stop_kills_every_arm_and_evaluates_nothing():
    logs = Path(tempfile.mkdtemp(prefix="arms-"))
    marker = logs / "evaluated"
    # Arm a spends $30 at once, then would run for a minute; arm b would run for a minute.
    arms = {
        "t-a": write_pair(logs, "t-a", "p1", 30.0) + " && sleep 60 && touch " + str(logs / "a-finished"),
        "t-b": "sleep 60 && touch " + str(logs / "b-finished"),
    }
    started = time.monotonic()
    code = run_arms.run(arms, logs, "t-*", 25.0, 0.2, f"touch {marker}", None, None)
    assert code == 3
    assert time.monotonic() - started < 20
    assert not (logs / "a-finished").exists() and not (logs / "b-finished").exists()
    assert not marker.exists()


def stubborn_child(pidfile: Path) -> str:
    # A child that ignores SIGTERM and records its pid, started in the background.
    return f"sh -c 'trap \"\" TERM; echo $$ > {pidfile}; sleep 60' &"


def gone(pidfile: Path) -> bool:
    pid = int(pidfile.read_text())
    for _ in range(50):
        try:
            os.kill(pid, 0)
        except ProcessLookupError:
            return True
        time.sleep(0.1)
    return False


def test_a_stop_kills_children_that_ignore_sigterm_even_after_their_leader_exits():
    logs = Path(tempfile.mkdtemp(prefix="arms-"))
    a_pid, b_pid = logs / "a.pid", logs / "b.pid"
    run_arms.GRACE = 1.0
    try:
        arms = {
            # Arm a's leader exits at once and leaves the child running.
            "t-a": stubborn_child(a_pid),
            # Arm b's leader waits on its child, then spends past the cap.
            "t-b": stubborn_child(b_pid) + " sleep 1 && " + write_pair(logs, "t-b", "p1", 30.0) + " && wait",
        }
        code = run_arms.run(arms, logs, "t-*", 25.0, 0.2, None, None, None)
    finally:
        run_arms.GRACE = 10.0
    assert code == 3
    assert gone(a_pid) and gone(b_pid)


def test_the_api_limit_in_a_running_pair_stops_the_run_and_runs_on_stop():
    logs = Path(tempfile.mkdtemp(prefix="arms-"))
    cleaned = logs / "cleaned"
    arms = {"t-a": write_pair(logs, "t-a", "p1", 0.5, LIMIT) + " && sleep 60"}
    code = run_arms.run(arms, logs, "t-*", 25.0, 0.2, None, f"touch {cleaned}", None)
    assert code == 4
    assert cleaned.exists()


def test_arms_that_finish_under_the_cap_are_each_evaluated():
    logs = Path(tempfile.mkdtemp(prefix="arms-"))
    arms = {"t-a": write_pair(logs, "t-a", "p1", 1.0), "t-b": write_pair(logs, "t-b", "p1", 2.0)}
    code = run_arms.run(arms, logs, "t-*", 25.0, 0.2, f"touch {logs}/eval-{{name}}", None, None)
    assert code == 0
    assert (logs / "eval-t-a").exists() and (logs / "eval-t-b").exists()


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} passed")
