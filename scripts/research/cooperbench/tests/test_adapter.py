"""The adapter's container flow, against a fake container and a fake host (no docker, no daemon)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from musterd_cooperbench import adapter as ad
from musterd_cooperbench.team import PairTeam, Seat


class FakeEnv:
    """Records every command; answers the few the adapter reads back."""

    def __init__(self, image, network=None, extra_run_args=None, backend="docker"):
        self.image, self.run_args = image, list(extra_run_args or [])
        self.commands: list[str] = []
        self.files: dict[str, str] = {}
        self.cleaned = False

    def execute(self, action, cwd="", *, timeout=None):
        cmd = action["command"]
        self.commands.append(cmd)
        if cmd.startswith("cat > "):
            path = cmd.split()[2].strip("'")
            self.files[path] = cmd.split("\n", 1)[1].rsplit("\nCOOPERBENCH_HEREDOC_EOF_5e7b", 1)[0]
            return {"returncode": 0, "output": ""}
        if cmd.startswith("cat "):
            path = cmd.split()[1].strip("'")
            if path.endswith("patch.txt"):
                return {"returncode": 0, "output": "diff --git a/x b/x\n"}
            return {"returncode": 0, "output": ""}
        return {"returncode": 0, "output": "/usr/local/bin/musterd"}

    def cleanup(self):
        self.cleaned = True


class FakeHost:
    decided: list[str] = []

    def __init__(self, workdir, port):
        pass

    def run(self, *args, timeout=60):
        if args[:2] == ("requests", "--pending"):
            return json.dumps([{"id": "01M5REQUESTXXXXXXXXXXXXXXX", "seat": "agent1"}])
        if args[:2] == ("requests", "decide"):
            FakeHost.decided.append(args[2])
        return ""


@pytest.fixture
def wired(monkeypatch, tmp_path):
    envs: list[FakeEnv] = []

    def build(image, network=None, extra_run_args=None, backend="docker"):
        envs.append(FakeEnv(image, network, extra_run_args, backend))
        return envs[-1]

    pair = PairTeam(run_id="r1", team="cb-r1", port=4999, workdir=tmp_path)
    pair.seats = {"agent1": Seat("agent1", "mskey_test"), "agent2": Seat("agent2", "mskey_test2")}
    released: list[str] = []
    monkeypatch.setattr(ad.cc, "_build_environment", build)
    monkeypatch.setattr(ad.cc, "resolve_credentials", lambda: {"ANTHROPIC_API_KEY": "sk-test"})
    monkeypatch.setattr(ad.cc, "_find_session_jsonl", lambda env: "")
    monkeypatch.setattr(ad.REGISTRY, "acquire", lambda run_id, agents: pair)
    monkeypatch.setattr(ad.REGISTRY, "release", lambda run_id, keep_logs_in=None: released.append(run_id))
    monkeypatch.setattr(ad.cfg, "Cli", FakeHost)
    return envs, released


def run(**kw):
    return ad.ClaudeCodeMusterdRunner().run(
        "Implement feature 1.",
        "cooperbench/click:task2068",
        agent_id="agent1",
        agents=["agent1", "agent2"],
        config={"run_id": "r1"},
        **kw,
    )


def test_container_reaches_the_daemon_on_loopback_and_mounts_the_pack(wired):
    envs, _ = wired
    run()
    assert "--network=host" in envs[0].run_args
    assert f"{ad.HOST_PACK_DIR}:{ad.CONTAINER_PACK_DIR}:ro" in envs[0].run_args


def test_seat_is_admitted_excluded_from_git_and_wired(wired):
    envs, _ = wired
    FakeHost.decided.clear()
    result = run()
    cmds = "\n".join(envs[0].commands)
    assert "npm install -g --ignore-scripts" in cmds
    assert "musterd claim agent1 --team cb-r1 --key mskey_test" in cmds
    assert FakeHost.decided == ["01M5REQUESTXXXXXXXXXXXXXXX"]
    assert ".musterd/" in cmds and ".git/info/exclude" in cmds
    mcp = json.loads(envs[0].files[ad.CONTAINER_MCP_CONFIG])
    assert mcp["mcpServers"]["musterd"]["env"]["MUSTERD_CLAIM"] == "seat:agent1"
    assert mcp["mcpServers"]["musterd"]["env"]["MUSTERD_SERVER"] == "http://127.0.0.1:4999"
    settings = json.loads(envs[0].files[ad.CONTAINER_SETTINGS])
    assert "musterd gate check" in json.dumps(settings["hooks"]["PreToolUse"])
    assert result.patch == "diff --git a/x b/x\n"
    assert result.error is None


def test_claude_runs_with_only_musterd_and_no_coop_commands(wired):
    envs, _ = wired
    run()
    invoke = next(c for c in envs[0].commands if "claude --verbose" in c)
    assert "--mcp-config /tmp/musterd-mcp.json --strict-mcp-config" in invoke
    assert f"--settings {ad.CONTAINER_SETTINGS}" in invoke
    assert "COOP_REDIS_URL" not in invoke
    instruction = envs[0].files["/tmp/cb-instruction.txt"]
    assert "coop-send" not in instruction and "lane_open" in instruction


def test_the_pair_is_released_and_the_container_cleaned_even_on_failure(wired, monkeypatch):
    envs, released = wired
    monkeypatch.setattr(ad, "_admit_in_container", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("no bind")))
    result = run()
    assert result.error == "no bind"
    assert envs[0].cleaned and released == ["r1"]
