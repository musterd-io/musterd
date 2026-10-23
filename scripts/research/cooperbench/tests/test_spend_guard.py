"""spend_guard.py: the hard stop and the API limit, read the same way for every run (lane 01M5KHD19K).

Runs under pytest, or as `python3 tests/test_spend_guard.py` where pytest is not installed.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import spend_guard  # noqa: E402


def logs_with(pairs: dict[str, dict]) -> Path:
    """{"run/pair": {"cost": float | None, "stream": str}} -> a logs folder in CooperBench's layout."""
    root = Path(tempfile.mkdtemp(prefix="guard-test-"))
    for where, p in pairs.items():
        d = root / where
        d.mkdir(parents=True)
        if p.get("cost") is not None:
            (d / "result.json").write_text(json.dumps({"total_cost": p["cost"]}))
        (d / "agent1_stream.jsonl").write_text(p.get("stream", "{}\n"))
    return root


def test_spend_sums_finished_pairs_of_the_matching_runs_only():
    logs = logs_with({
        "coord-team/a": {"cost": 1.25}, "coord-smoke/b": {"cost": 2.0},
        "coord-coop/c": {"cost": None},  # still running: no result.json yet
        "claim-solo/d": {"cost": 9.0},  # another run's pairs are not this run's spend
    })
    out = spend_guard.check(logs, "coord-*", 35.0)
    assert out == {"spent": 3.25, "cap": 35.0, "api_limit": False, "stop": None}


def test_the_hard_stop_is_reached_at_the_cap():
    logs = logs_with({"coord-team/a": {"cost": 20.0}, "coord-coop/b": {"cost": 15.0}})
    assert spend_guard.check(logs, "coord-*", 34.95)["stop"] == "hard_stop"
    assert spend_guard.main(["--logs", str(logs), "--runs", "coord-*", "--cap", "34.95"]) == 3


def test_the_api_limit_in_a_running_pair_stops_the_run_before_the_cap():
    limited = '{"type":"result","result":"API Error: 400 You have reached your specified API usage limits."}\n'
    logs = logs_with({"coord-team/a": {"cost": 1.0}, "coord-coop/b": {"cost": None, "stream": limited}})
    out = spend_guard.check(logs, "coord-*", 35.0)
    assert out["api_limit"] and out["stop"] == "api_limit"
    assert spend_guard.main(["--logs", str(logs), "--runs", "coord-*", "--cap", "35"]) == 4


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} passed")
