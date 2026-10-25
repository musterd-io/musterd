from pathlib import Path

from musterd_cooperbench.config import (
    claude_smoke_argv,
    claude_smoke_env,
    claude_smoke_mcp_env,
)


def test_smoke_claude_env_keeps_only_runtime_inputs(tmp_path: Path):
    host_env = {
        "ANTHROPIC_API_KEY": "model-secret",
        "GH_TOKEN": "github-secret",
        "AWS_SECRET_ACCESS_KEY": "cloud-secret",
        "MUSTERD_AGENT_KEY": "daemon-secret",
        "HOME": "/Users/operator",
        "PATH": "/Users/operator/bin:/usr/bin",
        "LANG": "C.UTF-8",
        "PREFIX": "/opt/musterd-seat",
    }
    seat_env = {
        "MUSTERD_SERVER": "http://127.0.0.1:4849",
        "MUSTERD_LAUNCH_SURFACE": "claude-code",
        "MUSTERD_CONFIG": "/tmp/seat-home/musterd-config.json",
        "MUSTERD_TEAM": "smoke-team",
        "MUSTERD_CLAIM": "seat:agent1",
        "MUSTERD_AUTOJOIN": "1",
        "PATH": "/opt/musterd-seat/bin:/Users/operator/bin:/usr/bin",
        "GH_TOKEN": "seat-copy-of-github-secret",
    }

    env = claude_smoke_env(
        host_env,
        seat_env,
        home=tmp_path / "seat-home",
        prefix=Path("/opt/musterd-seat"),
    )

    assert env == {
        "ANTHROPIC_API_KEY": "model-secret",
        "LANG": "C.UTF-8",
        "MUSTERD_SERVER": "http://127.0.0.1:4849",
        "MUSTERD_LAUNCH_SURFACE": "claude-code",
        "MUSTERD_CONFIG": "/tmp/seat-home/musterd-config.json",
        "MUSTERD_TEAM": "smoke-team",
        "MUSTERD_CLAIM": "seat:agent1",
        "MUSTERD_AUTOJOIN": "1",
        "HOME": str(tmp_path / "seat-home"),
        "PATH": "/opt/musterd-seat/bin:/usr/local/bin:/usr/bin:/bin",
    }


def test_smoke_claude_argv_uses_default_permissions_and_only_required_tools(
    tmp_path: Path,
):
    argv = claude_smoke_argv(
        "exercise the lane gate",
        model="claude-haiku-5-5",
        settings=tmp_path / "settings.json",
        mcp_config=tmp_path / "mcp.json",
    )

    assert "bypassPermissions" not in argv
    assert argv[argv.index("--permission-mode") + 1] == "default"
    # Read is allowed (finding 025 pre-flight): Claude Code 2.1.307 refuses to edit an unread file.
    assert argv[argv.index("--tools") + 1] == "Read,Edit,Write"
    allowed = argv[argv.index("--allowedTools") + 1 : argv.index("--setting-sources")]
    assert allowed == [
        "Read(src/**)",
        "Write(src/**)",
        "Edit(src/**)",
        "mcp__musterd__team_inbox_check",
        "mcp__musterd__lane_open",
    ]


def test_smoke_mcp_env_contains_only_seat_wiring():
    env = claude_smoke_mcp_env(
        {
            "MUSTERD_SERVER": "http://127.0.0.1:4849",
            "MUSTERD_TEAM": "smoke-team",
            "PATH": "/host/path",
            "GH_TOKEN": "github-secret",
            "ANTHROPIC_API_KEY": "model-secret",
        }
    )

    assert env == {
        "MUSTERD_SERVER": "http://127.0.0.1:4849",
        "MUSTERD_TEAM": "smoke-team",
    }
