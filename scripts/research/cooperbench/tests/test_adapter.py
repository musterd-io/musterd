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
        self.stream = INIT_CONNECTED

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
            if path.endswith("claude-stream.jsonl"):
                return {"returncode": 0, "output": self.stream}
            return {"returncode": 0, "output": ""}
        if cmd == "npm root -g":
            return {"returncode": 0, "output": "/usr/lib/node_modules\n"}
        if cmd == ad.ENSURE_NODE22:
            return {"returncode": 0, "output": "v22.23.3\n"}
        return {"returncode": 0, "output": "/usr/local/bin/musterd"}

    def cleanup(self):
        self.cleaned = True


INIT_CONNECTED = json.dumps(
    {"type": "system", "subtype": "init", "mcp_servers": [{"name": "musterd", "status": "connected"}]}
)
INIT_FAILED = json.dumps(
    {"type": "system", "subtype": "init", "mcp_servers": [{"name": "musterd", "status": "failed"}]}
)


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


def test_node_22_is_ensured_after_setup_and_before_musterd_installs(wired):
    """An Alpine image's apk Node is too old for musterd's CLI (go_chi/27, pilot 2026-10-21)."""
    envs, _ = wired
    run()
    cmds = envs[0].commands
    setup = next(i for i, c in enumerate(cmds) if c.startswith("bash ") and "setup" in c)
    node = cmds.index(ad.ENSURE_NODE22)
    install = next(i for i, c in enumerate(cmds) if c.startswith("npm install -g"))
    assert setup < node < install
    assert "unofficial-builds.nodejs.org" in ad.ENSURE_NODE22 and "x86_64" in ad.ENSURE_NODE22
    assert ad.ENSURE_NODE22.endswith("node -v")


def test_the_mcp_entry_is_resolved_from_npms_global_root(wired):
    envs, _ = wired
    run()
    mcp = json.loads(envs[0].files[ad.CONTAINER_MCP_CONFIG])
    assert mcp["mcpServers"]["musterd"]["args"] == ["/usr/lib/node_modules/@musterd/mcp/dist/index.js"]


def test_a_run_whose_musterd_mcp_never_connected_is_an_error_not_a_score(wired, monkeypatch):
    envs, _ = wired
    original = FakeEnv.__init__

    def failed_init(self, *a, **k):
        original(self, *a, **k)
        self.stream = INIT_FAILED

    monkeypatch.setattr(FakeEnv, "__init__", failed_init)
    result = run()
    assert result.error is not None and "status: failed" in result.error


def test_mcp_status_reads_the_init_event():
    assert ad.musterd_mcp_status(INIT_CONNECTED) == "connected"
    assert ad.musterd_mcp_status(INIT_FAILED) == "failed"
    assert ad.musterd_mcp_status("") == "absent"
