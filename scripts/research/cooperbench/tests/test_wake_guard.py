"""wake_guard reads a live pair daemon's priced wakes and stops on a pair or total cap."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import wake_guard


def pair_db(root: Path, name: str, costs: list[float]) -> Path:
    workdir = root / f"cb-musterd-{name}"
    workdir.mkdir()
    db = workdir / "musterd.db"
    con = sqlite3.connect(db)
    con.execute("CREATE TABLE audit (ts INTEGER, actor TEXT, action TEXT, result TEXT, detail TEXT)")
    for i, c in enumerate(costs):
        con.execute(
            "INSERT INTO audit VALUES (?, NULL, 'residency.wake_cost', 'allow', ?)",
            (i, json.dumps({"lease_id": f"L{i}", "cost_usd": c})),
        )
    con.execute("INSERT INTO audit VALUES (99, NULL, 'residency.wake_leased', 'allow', '{}')")
    con.commit()
    con.close()
    return workdir


def test_sums_priced_wakes_per_live_pair(tmp_path):
    pair_db(tmp_path, "a", [0.17, 0.26, 0.42])
    pair_db(tmp_path, "b", [0.31])
    out = wake_guard.check(str(tmp_path / "cb-musterd-*"), pair_cap=6, total_cap=24.8)
    assert out["live_wake_usd"] == 1.16
    assert out["stop"] is None and out["over_pair"] == []


def test_stops_on_a_pair_cap_and_on_the_total_with_finished_spend(tmp_path):
    pair_db(tmp_path, "a", [1.0] * 7)
    out = wake_guard.check(str(tmp_path / "cb-musterd-*"), pair_cap=6, total_cap=24.8)
    assert out["stop"] == "pair_cap" and len(out["over_pair"]) == 1
    out = wake_guard.check(str(tmp_path / "cb-musterd-*"), pair_cap=10, total_cap=24.8, finished_usd=18.0)
    assert out["stop"] == "total_cap" and out["total_usd"] == 25.0


def test_an_unreadable_db_counts_zero_never_a_guess(tmp_path):
    (tmp_path / "cb-musterd-x").mkdir()
    (tmp_path / "cb-musterd-x" / "musterd.db").write_text("not a database")
    out = wake_guard.check(str(tmp_path / "cb-musterd-*"), pair_cap=1, total_cap=1)
    assert out["live_wake_usd"] == 0.0 and out["stop"] is None


def test_the_loop_keeps_polling_until_a_pair_has_been_seen(tmp_path, monkeypatch):
    # Before any pair exists the glob is empty: the guard must wait, not exit (re-run smoke pair, 11-04).
    calls = {"n": 0}

    def fake_sleep(_s):
        calls["n"] += 1
        if calls["n"] == 1:
            pair_db(tmp_path, "late", [0.5])
        elif calls["n"] == 2:
            import shutil

            shutil.rmtree(tmp_path / "cb-musterd-late")

    monkeypatch.setattr(wake_guard.time, "sleep", fake_sleep)
    code = wake_guard.main(["--pairs", str(tmp_path / "cb-musterd-*"), "--pair-cap", "6", "--total-cap", "110"])
    assert code == 0 and calls["n"] == 2
