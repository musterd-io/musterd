"""The OpenHands arms: the docker swap, the musterd plugin, the dispatch patches, and the two shims.

No docker, no daemon, no LLM: CooperBench's runner and docker are faked where they would run.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import types
from pathlib import Path

import pytest
from cooperbench.agents import AgentResult
from openhands.sdk import LLM
from openhands.tools.preset.default import get_coop_system_prompt

from musterd_cooperbench import openhands as ohm
from musterd_cooperbench import team as team_mod
from musterd_cooperbench.prompt import musterd_system_section
from musterd_cooperbench.team import PairTeam, Seat

OH_DIR = Path(ohm.__file__).parent / "oh_container"


def pair(tmp_path: Path) -> PairTeam:
    p = PairTeam(run_id="r1", team="cb-r1", port=4999, workdir=tmp_path)
    p.seats = {"agent1": Seat("agent1", "mskey_test"), "agent2": Seat("agent2", "mskey_test2")}
    return p


def llm() -> LLM:
    return LLM(model="anthropic/claude-haiku-5-5", api_key="sk-test")


# ── the docker swap ──


def test_agent_server_runs_on_loopback_on_its_own_port_with_host_networking():
    args = ohm.docker_run_args("img:task1-oh", name="c1", port=40123, env={"AGENT_ID": "agent1"}, musterd=False)
    assert "--network=host" in args and "-e" in args and "AGENT_ID=agent1" in args
    assert args[args.index("-w") + 1] == "/"  # as Modal: the server's state stays out of the repo's patch
    assert "--init" in args  # as Modal: the agent-server is not PID 1, so its MCP child's ppid isn't 1
    assert args[-5:] == ["img:task1-oh", "--host", "127.0.0.1", "--port", "40123"]
    assert not any(ohm.CONTAINER_PACK_DIR in a for a in args)


def test_the_musterd_container_mounts_the_pack_the_shims_and_the_interrupt_pth():
    args = ohm.docker_run_args("img:task1-oh", name="c1", port=40123, env={}, musterd=True)
    mounts = [args[i + 1] for i, a in enumerate(args) if a == "-v"]
    assert f"{ohm.HOST_PACK_DIR}:{ohm.CONTAINER_PACK_DIR}:ro" in mounts
    assert f"{ohm.HOST_OH_DIR}:{ohm.CONTAINER_OH_DIR}:ro" in mounts
    assert any(m.endswith(f"{ohm.AGENT_SITE_PACKAGES}/musterd-oh-inbox.pth:ro") for m in mounts)


def test_git_url_keeps_an_ip_and_resolves_a_container_name(monkeypatch):
    assert ohm.host_reachable_git_url(None) is None
    assert ohm.host_reachable_git_url("git://10.0.0.5:9418/r.git") == "git://10.0.0.5:9418/r.git"
    monkeypatch.setattr(team_mod, "container_ip", lambda name: "172.18.0.2")
    assert ohm.host_reachable_git_url("git://cooperbench-git:9418/r1.git") == "git://172.18.0.2:9418/r1.git"


# ── the plugin ──


def test_the_plugin_gates_only_the_file_editor_and_carries_the_seat_env():
    env = {"MUSTERD_CLAIM": "seat:agent1", "MUSTERD_LAUNCH_SURFACE": "other"}
    files = ohm.plugin_files(env, "/usr/lib/node_modules/@musterd/mcp/dist/index.js")
    hooks = json.loads(files["hooks/hooks.json"])["hooks"]
    assert list(hooks) == ["PreToolUse"]
    assert hooks["PreToolUse"][0]["matcher"] == "file_editor"
    assert hooks["PreToolUse"][0]["hooks"][0]["command"] == f"node {ohm.GATE_SHIM}"
    mcp = json.loads(files[".mcp.json"])["mcpServers"]["musterd"]
    assert mcp["command"] == "sh" and mcp["env"] == env
    assert mcp["args"] == ["-c", "cd /workspace/repo && exec node /usr/lib/node_modules/@musterd/mcp/dist/index.js"]
    assert json.loads(files[".claude-plugin/plugin.json"])["name"] == "musterd"


def test_the_plugin_loads_through_openhands_own_plugin_loader(tmp_path):
    from openhands.sdk.plugin import Plugin

    for rel, content in ohm.plugin_files({"MUSTERD_CLAIM": "seat:agent1"}, "/x/index.js").items():
        (tmp_path / rel).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / rel).write_text(content)
    plugin = Plugin.load(tmp_path)
    assert plugin.hooks is not None and plugin.hooks.pre_tool_use[0].matches("file_editor")
    assert not plugin.hooks.pre_tool_use[0].matches("terminal")
    assert "musterd" in (plugin.mcp_config or {}).get("mcpServers", {})


def test_the_seat_reports_its_surface_as_other(tmp_path):
    env = ohm.oh_seat_env(pair(tmp_path), "agent1")
    assert env["MUSTERD_LAUNCH_SURFACE"] == "other" and env["MUSTERD_CLAIM"] == "seat:agent1"


# ── the dispatch patches ──


def test_patches_are_no_ops_outside_these_arms():
    assert ohm.current_arm() is None
    assert ohm.oh._needs_modal_redis("redis://localhost:6379") is True
    assert type(ohm.oh.ModalSandboxContext("img", 60)) is ohm._ORIGINAL_SANDBOX
    agent = ohm.oh_preset.get_default_agent(llm=llm(), cli_mode=True, coop_info=None)
    assert "send_message" in {t.name for t in agent.tools}


def test_inside_an_arm_the_sandbox_is_docker_and_redis_and_git_are_the_runners():
    with ohm.arm(ohm.ArmState(mode="docker", git_url="git://172.18.0.2:9418/r1.git")):
        assert isinstance(ohm.oh.ModalSandboxContext("img", 60), ohm.DockerSandboxContext)
        assert ohm.oh._needs_modal_redis("redis://localhost:6379#run:r1") is False
        assert ohm.oh._get_or_create_git_server("r1", ["agent1"]) == "git://172.18.0.2:9418/r1.git"
        ohm.oh._release_git_server("r1")  # never the Modal server's release
    assert ohm.current_arm() is None


def test_the_musterd_agent_drops_redis_messaging_and_takes_the_collaboration_slot():
    state = ohm.ArmState(mode="musterd", agent_id="agent1", agents=("agent1", "agent2"))
    with ohm.arm(state):
        agent = ohm.oh_preset.get_default_agent(llm=llm(), cli_mode=True, coop_info=None)
    names = {t.name for t in agent.tools}
    assert not names & ohm.OH_MESSAGING_TOOLS and {"terminal", "file_editor"} <= names
    collab = agent.system_prompt_kwargs["collaboration"]
    assert "team_send" in collab and "send_message" not in collab and "agent2" in collab


def test_the_plain_docker_arm_keeps_cooperbench_agent():
    with ohm.arm(ohm.ArmState(mode="docker")):
        agent = ohm.oh_preset.get_default_agent(
            llm=llm(), cli_mode=True, coop_info={"agent_id": "agent1", "agents": ["agent1", "agent2"]}
        )
    assert "send_message" in agent.system_prompt_kwargs["collaboration"]


@pytest.mark.parametrize("mode", ["docker", "musterd"])
def test_both_arms_run_without_extended_thinking(mode):
    assert llm().extended_thinking_budget  # OpenHands' default, which CooperBench's own arm keeps
    state = ohm.ArmState(mode=mode, agent_id="agent1", agents=("agent1", "agent2"))
    with ohm.arm(state):
        agent = ohm.oh_preset.get_default_agent(
            llm=llm(), cli_mode=True, coop_info={"agent_id": "agent1", "agents": ["agent1", "agent2"]}
        )
    assert agent.llm.extended_thinking_budget is None


def test_musterd_calls_are_counted_from_action_events():
    assert ohm.is_musterd_call(type("ActionEvent", (), {"tool_name": "team_inbox_check"})())
    assert ohm.is_musterd_call(type("ActionEvent", (), {"tool_name": "lane_open"})())
    other = type("ActionEvent", (), {"tool_name": "file_editor"})()
    assert not ohm.is_musterd_call(other)
    assert not ohm.is_musterd_call(type("MessageEvent", (), {"tool_name": "team_send"})())


# ── the prompt ──


def test_the_musterd_section_mirrors_cooperbench_coop_section():
    ours = musterd_system_section("agent1", ["agent2"], git_enabled=True)
    theirs = get_coop_system_prompt("agent1", ["agent2"], messaging_enabled=True, git_enabled=True)
    heads = lambda s: [line for line in s.splitlines() if line.startswith(("#", "<", "You are agent1", "Do not skip"))]  # noqa: E731
    assert heads(ours) == heads(theirs)
    assert "every edit" not in ours.lower() and "file editor are gated" in ours


# ── the runners ──


@pytest.fixture
def fake_runner(monkeypatch, tmp_path):
    calls: list[dict] = []
    released: list[str] = []

    def fake_run(self, task, image, **kwargs):
        calls.append({"task": task, "image": image, "arm": ohm.current_arm(), **kwargs})
        state = ohm.current_arm()
        if state is not None and state.mode == "musterd" and kwargs.get("agent_id") != "silent":
            state.musterd_calls += 2
        return AgentResult(status="Submitted", patch="diff", cost=0.1, steps=3, messages=[], error=None)

    monkeypatch.setattr(ohm.oh.OpenHandsSDKRunner, "run", fake_run)
    monkeypatch.setattr(ohm.REGISTRY, "acquire", lambda run_id, agents: pair(tmp_path))
    monkeypatch.setattr(ohm.REGISTRY, "release", lambda run_id, keep_logs_in=None: released.append(run_id))
    return calls, released


def test_the_musterd_runner_uses_no_redis_and_releases_its_team(fake_runner):
    calls, released = fake_runner
    result = ohm.OpenHandsMusterdRunner().run(
        "Implement feature 1.",
        "img:task1",
        agent_id="agent1",
        agents=["agent1", "agent2"],
        comm_url="redis://localhost:6379#run:r1",
        messaging_enabled=True,
        config={"run_id": "r1"},
    )
    assert calls[0]["comm_url"] is None and calls[0]["messaging_enabled"] is False
    assert calls[0]["task"] == "Implement feature 1."  # the task is CooperBench's, unchanged
    state = calls[0]["arm"]
    assert state.mode == "musterd" and state.seat_env["MUSTERD_CLAIM"] == "seat:agent1"
    assert released == ["r1"] and result.error is None


def test_a_musterd_run_with_no_musterd_call_is_an_error_not_a_score(fake_runner):
    result = ohm.OpenHandsMusterdRunner().run(
        "t", "img:task1", agent_id="silent", agents=["silent", "agent2"], config={"run_id": "r1"}
    )
    assert result.status == "Error" and "no musterd tool call" in result.error


def test_the_docker_runner_passes_everything_through(fake_runner, monkeypatch):
    calls, _ = fake_runner
    monkeypatch.setattr(ohm, "host_reachable_git_url", lambda url: url and url.replace("cooperbench-git", "172.18.0.2"))
    ohm.OpenHandsDockerRunner().run(
        "t", "img:task1", agent_id="agent1", comm_url="redis://localhost:6379#run:r1",
        git_server_url="git://cooperbench-git:9418/r1.git", git_enabled=True,
    )  # fmt: skip
    assert calls[0]["comm_url"] == "redis://localhost:6379#run:r1"
    assert calls[0]["arm"].mode == "docker" and calls[0]["arm"].git_url == "git://172.18.0.2:9418/r1.git"


# ── the container shims ──


@pytest.mark.skipif(shutil.which("node") is None, reason="needs node")
def test_the_gate_shim_sends_only_editor_writes_and_translates_a_deny():
    script = f"""
    import {{ toMusterdPayload, toOpenHandsVerdict }} from '{OH_DIR / "oh-gate.mjs"}';
    const ev = (command) => ({{ tool_name: 'file_editor', tool_input: {{ command, path: '/workspace/repo/a.py' }}, session_id: 's1', working_dir: '/workspace/repo' }});
    const out = {{
      write: toMusterdPayload(ev('str_replace')),
      view: toMusterdPayload(ev('view')),
      terminal: toMusterdPayload({{ tool_name: 'terminal', tool_input: {{ command: 'ls' }} }}),
      deny: toOpenHandsVerdict(JSON.stringify({{ permission: 'deny', hookSpecificOutput: {{ permissionDecision: 'deny', permissionDecisionReason: 'not your lane' }} }})),
      allow: toOpenHandsVerdict(''),
    }};
    console.log(JSON.stringify(out));
    """
    proc = subprocess.run(["node", "--input-type=module", "-e", script], capture_output=True, text=True, check=True)
    out = json.loads(proc.stdout)
    assert out["write"] == {
        "tool_name": "Edit",
        "tool_input": {"file_path": "/workspace/repo/a.py"},
        "session_id": "s1",
        "cwd": "/workspace/repo",
    }
    assert out["view"] is None and out["terminal"] is None
    assert out["deny"] == {"decision": "deny", "reason": "not your lane"}
    assert out["allow"] is None


def test_the_interrupt_slot_injects_the_daemon_line_after_the_redis_check(monkeypatch):
    import importlib.util

    spec = importlib.util.spec_from_file_location("musterd_oh_inbox", OH_DIR / "musterd_oh_inbox.py")
    inbox = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(inbox)

    order: list[str] = []

    class LocalConversation:
        def _check_inbox_messages(self):
            order.append("redis")

        def _on_event(self, event):
            order.append(event)

    fake = types.SimpleNamespace(
        LocalConversation=LocalConversation,
        MessageEvent=lambda source, llm_message: ("event", source, llm_message),
        Message=lambda role, content: (role, content),
        TextContent=lambda text: text,
    )
    inbox.patch(fake)
    monkeypatch.setattr(inbox, "interrupt_line", lambda: "⚡ musterd [cb-r1]: agent2 (message) — read it")
    LocalConversation()._check_inbox_messages()
    assert order == ["redis", ("event", "user", ("user", ["⚡ musterd [cb-r1]: agent2 (message) — read it"]))]

    order.clear()
    monkeypatch.setattr(inbox, "interrupt_line", lambda: None)
    LocalConversation()._check_inbox_messages()
    assert order == ["redis"]


@pytest.mark.parametrize(
    ("stdout", "expected"),
    [
        ("⚡ musterd [cb-r1]: steer from me (steer) — read it\n", "⚡ musterd [cb-r1]: steer from me (steer) — read it"),
        ("musterd: the interrupt line is deaf — this seat's session lease is dead\n", None),
        ("", None),
    ],
)
def test_only_a_raised_line_reaches_the_conversation(monkeypatch, stdout, expected):
    from musterd_cooperbench.oh_container import musterd_oh_inbox as inbox

    monkeypatch.setattr(inbox.subprocess, "run", lambda *a, **k: types.SimpleNamespace(stdout=stdout))
    assert inbox.interrupt_line() == expected


def test_the_pth_loads_the_interrupt_module_from_its_mount():
    line = (OH_DIR / "musterd-oh-inbox.pth").read_text().strip()
    assert line.startswith("import ") and f"'{ohm.CONTAINER_OH_DIR}'" in line and line.endswith("import musterd_oh_inbox")
