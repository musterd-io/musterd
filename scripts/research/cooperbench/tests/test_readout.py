"""readout.py's stream reads: the API-limit label and the move after a held refusal (lane 01M5KHD19K).

Runs under pytest, or as `python3 tests/test_readout.py` where pytest is not installed.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import readout  # noqa: E402

OLD_HELD = (
    "PreToolUse:Edit hook error: blocked: 'src/a.py' is held by agent1 (lane \"feature a\", named it "
    "first, since 2026-10-22T18:30:00Z) — ask them to hand it off or narrow their lane, wait for that "
    "lane to finish, or split the work by handoff."
)
NEW_HELD = (
    "PreToolUse:Edit hook error: blocked: 'src/a.py' is held by agent1 (lane 01ABC \"feature a\", named "
    "it first, since 2026-10-22T18:30:00Z). Wait for that lane to finish in one call — team_inbox_check "
    "{wait: 45, until_lane: \"01ABC\"} wakes when it resolves, with their branch — rather than messaging them"
)
HANDOVER = (
    "PreToolUse:Edit hook error: blocked once: 'src/a.py' was held by agent1 (lane \"feature a\", now done) "
    "while you waited, so it has probably changed. This is the one hand-over for that hold (ADR 697)."
)


def use(name: str, inp: dict, i: int) -> dict:
    return {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": f"t{i}", "name": name, "input": inp}]}}


def result(text: str, i: int) -> dict:
    return {"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": f"t{i}", "content": text}]}}


def pair_with(**streams: list[dict]) -> Path:
    d = Path(tempfile.mkdtemp(prefix="readout-test-"))
    for agent, events in streams.items():
        (d / f"{agent}_stream.jsonl").write_text("\n".join(json.dumps(e) for e in events) + "\n")
    return d


def test_a_wait_on_the_holders_lane_is_the_move_even_after_board_reads():
    pair = pair_with(agent2=[
        use("Edit", {"file_path": "src/a.py"}, 1), result(OLD_HELD, 1),
        use("mcp__musterd__lane_board", {}, 2), result("board", 2),
        use("mcp__musterd__team_inbox_check", {"wait": 45, "until_lane": "01ABC"}, 3), result("woke", 3),
    ])
    assert readout.held_refusal_moves(pair) == [{"agent": "agent2", "next": "wait_until_lane"}]


def test_moves_are_classified_by_tool_and_arguments():
    pair = pair_with(
        agent1=[use("Write", {}, 1), result(NEW_HELD, 1), use("mcp__musterd__team_send", {"act": "request_help", "to": "agent1"}, 2)],
        agent2=[use("Edit", {}, 1), result(OLD_HELD, 1), use("mcp__musterd__team_inbox_check", {"wait": 45}, 2)],
    )
    assert readout.held_refusal_moves(pair) == [
        {"agent": "agent1", "next": "message:request_help"},
        {"agent": "agent2", "next": "wait"},
    ]


def test_a_shell_command_or_an_edit_before_any_musterd_call_is_recorded_as_such():
    pair = pair_with(
        agent1=[use("Edit", {}, 1), result(OLD_HELD, 1), {"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t2", "name": "Bash", "input": {"command": "git fetch team"}}]}}],
        agent2=[use("Edit", {}, 1), result(OLD_HELD, 1), use("Edit", {}, 2)],
    )
    assert [m["next"] for m in readout.held_refusal_moves(pair)] == ["bash", "edit"]


def test_the_handover_refusal_is_not_a_held_refusal():
    pair = pair_with(agent2=[use("Edit", {}, 1), result(HANDOVER, 1), use("mcp__musterd__team_send", {"act": "message"}, 2)])
    assert readout.held_refusal_moves(pair) == []


def test_a_refusal_with_no_move_before_the_stream_ends_says_so():
    pair = pair_with(agent2=[use("Edit", {}, 1), result(OLD_HELD, 1)])
    assert readout.held_refusal_moves(pair) == [{"agent": "agent2", "next": "nothing before the run ended"}]


def test_the_api_usage_limit_is_seen_in_any_agents_stream():
    limited = {"type": "result", "is_error": True, "api_error_status": 400,
               "result": "API Error: 400 You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."}
    assert readout.api_limit(pair_with(agent1=[use("Edit", {}, 1)], agent2=[limited]))
    assert not readout.api_limit(pair_with(agent1=[use("Edit", {}, 1)], agent2=[use("Edit", {}, 1)]))


if __name__ == "__main__":
    tests = [v for k, v in sorted(globals().items()) if k.startswith("test_") and callable(v)]
    for t in tests:
        t()
        print("ok", t.__name__)
    print(f"{len(tests)} passed")
