"""costsplit.py: call pricing, tool classification and the output rescale (lane 01M6S2NF8R, finding 036).

Runs under pytest, or as `python3 tests/test_costsplit.py` where pytest is not installed.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import costsplit  # noqa: E402


def test_price_matches_claude_code_billing() -> None:
    # One agent from the flash run: result.json cost 0.2695888 for these tokens.
    u = {
        "input_tokens": 30,
        "output_tokens": 4761,
        "cache_read_input_tokens": 437444,
        "cache_creation_input_tokens": 17352,
        "cache_creation": {"ephemeral_5m_input_tokens": 17352, "ephemeral_1h_input_tokens": 0},
    }
    assert abs(costsplit.call_price(u) - 0.2695888) < 1e-9


def test_classify() -> None:
    c = costsplit.classify
    assert c("mcp__musterd__team_inbox_check", {}) == "musterd:team_inbox_check"
    assert c("Bash", {"command": "git fetch origin && git merge origin/agent2"}) == "git:integrate"
    assert c("Bash", {"command": "cd repo && python -m pytest tests/x.py -q"}) == "test"
    assert c("Bash", {"command": "grep -n foo src/a.py"}) == "read"
    assert c("Bash", {"command": "sed -i 's/a/b/' x.py"}) == "edit"
    assert c("Bash", {"command": "git diff --stat"}) == "git:inspect"
    assert c("Read", {}) == "read"
    assert c("Edit", {}) == "edit"


def test_split_rescales_output_to_result_json() -> None:
    with tempfile.TemporaryDirectory() as d:
        pair = Path(d) / "run" / "coop" / "r" / "1" / "f1_f2"
        pair.mkdir(parents=True)
        lines = [
            {"type": "assistant", "message": {"id": "m1", "usage": {"input_tokens": 1, "output_tokens": 9},
                                               "content": [{"type": "tool_use", "id": "t1", "name": "Read", "input": {}}]}},
            {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "x" * 400}]}},
            {"type": "assistant", "message": {"id": "m2", "usage": {"input_tokens": 1, "output_tokens": 9},
                                               "content": [{"type": "text", "text": "done"}]}},
        ]
        (pair / "agent1_stream.jsonl").write_text("\n".join(json.dumps(x) for x in lines))
        (pair / "result.json").write_text(json.dumps({"agents": {"agent1": {"output_tokens": 1000, "cost": 0.02}}}))
        r = costsplit.split([str(pair / "agent1_stream.jsonl")])
        assert r["calls"] == 2 and abs(r["reported"] - 0.02) < 1e-12
        # 1000 true output tokens split evenly (equal partial counts) at $20/MTok, plus 2 input tokens.
        assert abs(r["priced"] - (1000 * 20 + 2 * 4) / 1e6) < 1e-9
        assert set(r["issued"]) == {"read", "final"}
        # The read's 100-token result is re-read by the one later call.
        assert abs(r["carried"]["read"] - 100 * 0.2 / 1e6) < 1e-12


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
