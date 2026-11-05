"""Rider 7: the act-lane arm, against the same fake container and host as test_adapter.py."""

from __future__ import annotations

import json

import pytest

from musterd_cooperbench import adapter as ad
from musterd_cooperbench import config as cfg
from musterd_cooperbench import team
from musterd_cooperbench.prompt import build_instruction, musterd_block
from test_adapter import FakeEnv, FakeHost, run, wired  # noqa: F401 — the fixture
from test_config import _ts_command


@pytest.fixture
def act(monkeypatch):
    monkeypatch.setenv(team.ACT_LANE_ENV, "act")
    monkeypatch.setattr(ad, "ACT_QUIET_SECONDS", 0)
    monkeypatch.setattr(ad, "ACT_IDLE_SECONDS", 0)
    monkeypatch.setattr(ad, "ACT_POLL_SECONDS", 0)


def test_capture_hooks_match_claude_code_ts():
    assert cfg.SESSION_CAPTURE_HOOK == _ts_command("sessionCaptureHookCommand").replace(
        "${SESSION_CAPTURE_HOOK_MARKER}", "musterd-session-capture-hook"
    )
    assert cfg.SESSION_END_HOOK == _ts_command("sessionEndHookCommand").replace(
        "${SESSION_END_HOOK_MARKER}", "musterd-session-end-hook"
    )


def test_act_settings_add_capture_hooks_and_the_floor_and_never_a_skip_flag():
    s = cfg.claude_settings(lane="act")
    assert set(s["hooks"]) == {"PreToolUse", "PostToolUse", "SessionStart", "SessionEnd"}
    assert s["hooks"]["SessionStart"][0]["hooks"][0]["command"] == cfg.SESSION_CAPTURE_HOOK
    assert s["permissions"] == {"allow": cfg.PERMISSION_FLOOR}
    assert "dangerously" not in json.dumps(s)
    # The launch-lane settings are byte-identical to before.
    assert "permissions" not in cfg.claude_settings() and "SessionStart" not in cfg.claude_settings()["hooks"]


def test_act_block_keeps_the_coop_shape_and_drops_only_the_wait_sentences():
    launch, act = musterd_block("agent1", ["agent2"]), musterd_block("agent1", ["agent2"], lane="act")
    assert "wait: 45" in launch and "wait: 45" not in act and "until_lane" not in act
    assert "end your turn" in act and "Never poll" in act
    assert launch.count("\n1. ") == act.count("\n1. ") and launch.count("```") == act.count("```")
    assert launch.splitlines()[0] == act.splitlines()[0]
    assert "wait: 45" in build_instruction("T", agents=["agent1", "agent2"], agent_id="agent1", git_enabled=False)
    assert "wait: 45" not in build_instruction(
        "T", agents=["agent1", "agent2"], agent_id="agent1", git_enabled=False, lane="act"
    )


def test_team_sets_the_act_lane_policy_only_when_switched(monkeypatch):
    assert not team.act_lane()
    monkeypatch.setenv(team.ACT_LANE_ENV, "act")
    assert team.act_lane()
    assert team.ACT_LANE_POLICY[:2] == ["--lane", "act"] and "--hourly-cap" in team.ACT_LANE_POLICY


def test_unread_directed_counts_logged_acts_to_this_seat_only():
    delivery = json.dumps(
        [
            {"id": "a", "recipients": [{"seat": "agent1", "state": "logged"}]},
            {"id": "b", "recipients": [{"seat": "agent1", "state": "seen"}]},
            {"id": "c", "recipients": [{"seat": "agent2", "state": "logged"}]},
        ]
    )
    assert ad.unread_directed(delivery, "agent1") == 1
    assert ad.unread_directed("not json", "agent1") == 0


def test_act_lane_enrolls_starts_the_host_and_waits_for_the_seat(wired, act, tmp_path):  # noqa: F811
    envs, _ = wired
    (tmp_path / ".musterd").mkdir()
    (tmp_path / ".musterd" / "binding.json").write_text('{"admin": true}')
    (tmp_path / "config.json").write_text("{}")
    result = run(log_dir=str(tmp_path / "logs"))
    cmds = "\n".join(envs[0].commands)
    assert result.error is None, result.error
    # The wake reads project-local settings, the first call the same JSON by --settings.
    assert json.loads(envs[0].files[ad.CONTAINER_LOCAL_SETTINGS]) == json.loads(envs[0].files[ad.CONTAINER_SETTINGS])
    assert "claude mcp add musterd -s local" in cmds and "MUSTERD_CLAIM=seat:agent1" in cmds
    assert envs[0].files[f"{ad.CONTAINER_ADMIN_HOME}/.musterd/binding.json"] == '{"admin": true}'
    assert "musterd residency on --seat agent1 --workspace /workspace/repo --harness claude-code --host cb-r1-agent1" in cmds
    host = next(c for c in envs[0].commands if "musterd host --host cb-r1-agent1" in c)
    assert "--no-provision --no-gateway" in host and "ANTHROPIC_MODEL=claude-sonnet-4-5" in host
    assert "dangerously" not in host
    assert ".claude/" in cmds
    assert "test -s /workspace/repo/patch.txt" in cmds
    # The self-heal tombstone sits beside the binding, so musterd never rewrites the arm's hooks.
    tomb = json.loads(envs[0].files["/workspace/repo/.musterd/declined.json"])
    assert tomb["declined"][0]["surface"] == "musterd:self-heal"
    assert ad.HARNESS_LIVE_PROBE in cmds
    # The probe judges argv[0] only: neither its own pattern nor a launcher's MUSTERD_LAUNCH_SURFACE=claude-code counts.
    assert "$1 ~ /(^|" in ad.HARNESS_LIVE_PROBE and "claude$/" in ad.HARNESS_LIVE_PROBE
    assert (tmp_path / "logs" / "agent1_host.log").exists()


def test_without_the_switch_nothing_changes(wired):  # noqa: F811
    envs, _ = wired
    run()
    cmds = "\n".join(envs[0].commands)
    assert "residency on" not in cmds and "musterd host" not in cmds
    assert cfg.GIT_EXCLUDE_ACT not in cmds and ad.CONTAINER_LOCAL_SETTINGS not in envs[0].files
