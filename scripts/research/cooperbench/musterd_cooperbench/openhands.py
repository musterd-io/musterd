"""The OpenHands arms: CooperBench's `openhands_sdk` adapter in local docker, with and without musterd.

Load with ``COOPERBENCH_EXTERNAL_AGENTS=musterd_cooperbench.openhands`` and run ``cooperbench run
--setting coop -a openhands_sdk_docker …`` (the plain coop arm) or ``-a openhands_sdk_musterd …``.

Both arms run CooperBench's own ``OpenHandsSDKRunner.run`` at commit 63b9d44, called rather than
copied. That adapter starts every agent in a Modal cloud sandbox; these arms start the same published
``-oh`` image (the task image plus the OpenHands agent-server) in docker on the run machine instead,
because the musterd daemon only listens on loopback (ADR 040) and a Modal sandbox can't reach it.
Both arms get the same sandbox, so the swap doesn't favour either (nick, 2026-10-20).

The musterd arm then differs from the plain one in the coordination layer alone:

| | `openhands_sdk_docker` | `openhands_sdk_musterd` |
| --- | --- | --- |
| Messaging | `send_message` over Redis | the musterd MCP tools, on a fresh team per pair (team.py) |
| Hearing a partner mid-run | Redis inbox injected before every step | `musterd inbox --interrupt-check` injected in the same slot |
| File ownership | none | the ADR 150 lane gate as an OpenHands PreToolUse hook on `file_editor` |
| System prompt | CooperBench's collaboration section | the musterd section in the same slot (prompt.py) |

OpenHands has PreToolUse hooks (SDK v1.10, the version CooperBench vendors), but only the
agent-server enforces them: the client-side ``RemoteConversation`` runs session hooks alone. So the
gate and the MCP server ship as an OpenHands **plugin** in the container (``hooks/hooks.json`` and
``.mcp.json``), which the agent-server loads for the conversation. The hook command is
``oh-gate.mjs``, which turns OpenHands' payload into musterd's and musterd's verdict into OpenHands'
(oh_container/). The interrupt slot is ``musterd_oh_inbox.py``, loaded into the agent-server's
Python by a ``.pth`` file.

CooperBench's module is patched in a few places so these arms can reuse it. Every patch is a
dispatch on a thread-local that only these runners set, so CooperBench's own ``openhands_sdk``
behaves exactly as before in the same process.
"""

from __future__ import annotations

import contextlib
import json
import logging
import os
import shlex
import subprocess
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import openhands.sdk.conversation as oh_conversation
import openhands.tools.preset.default as oh_preset
from cooperbench.agents.openhands_agent_sdk import adapter as oh
from cooperbench.agents.registry import register
from openhands.sdk.plugin import PluginSource

from . import config as cfg
from .team import host_reachable_git_url
from .prompt import musterd_system_section
from .team import REGISTRY, PairTeam, free_port

logger = logging.getLogger(__name__)

HOST_PACK_DIR = os.environ.get("MUSTERD_PACK_DIR", "/opt/musterd-pack")
CONTAINER_PACK_DIR = "/opt/musterd-pack"
HOST_OH_DIR = Path(__file__).resolve().parent / "oh_container"
CONTAINER_OH_DIR = "/opt/musterd-oh"
# The `-oh` image's agent-server venv (CooperBench's docker/Dockerfile.agent-server).
AGENT_SITE_PACKAGES = "/opt/agent-server-venv/lib/python3.12/site-packages"
CONTAINER_REPO = "/workspace/repo"
CONTAINER_SEAT_HOME = "/tmp/musterd-seat"
PLUGIN_DIR = "/tmp/musterd-oh-plugin"
GATE_SHIM = f"{CONTAINER_OH_DIR}/oh-gate.mjs"
MCP_ENTRY_RELATIVE = "@musterd/mcp/dist/index.js"
# OpenHands has no musterd Surface of its own; `other` says so honestly (ADR 286).
OPENHANDS_SURFACE = "other"
# The tools musterd's MCP server exposes that a run must have called, or the arm wasn't musterd.
MUSTERD_TOOL_PREFIXES = ("team_", "lane_")
# The plain arm's messaging tools. They do nothing without REDIS_URL, which the musterd arm never
# sets, but a model would still see them advertised, so the musterd arm drops them.
OH_MESSAGING_TOOLS = {"send_message", "receive_message"}

# Node 22, as CooperBench's own claude_code setup.sh installs it (agents/claude_code/setup.sh at
# 63b9d44). musterd needs Node >= 22 and the task images don't carry Node.
INSTALL_NODE = (
    "set -e; "
    "if command -v apt-get >/dev/null 2>&1; then "
    "apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates gnupg >/dev/null; "
    "elif command -v apk >/dev/null 2>&1; then apk add --no-cache curl bash nodejs npm >/dev/null; fi; "
    "if ! command -v npm >/dev/null 2>&1; then "
    "curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null && "
    "apt-get install -y --no-install-recommends nodejs >/dev/null; fi; node --version"
)
INSTALL_MUSTERD = (
    f"npm install -g --ignore-scripts --no-audit --no-fund {CONTAINER_PACK_DIR}/musterd-*.tgz "
    "> /tmp/musterd-install.log 2>&1 && command -v musterd"
)


# ─────────────────────────── which arm this thread is running ───────────────────────────


@dataclass
class ArmState:
    mode: str  # "docker" or "musterd"
    git_url: str | None = None
    agent_id: str = "agent"
    agents: tuple[str, ...] = ()
    git_enabled: bool = False
    pair: PairTeam | None = None
    seat_env: dict[str, str] | None = None
    # musterd tool calls the agent made, counted by a conversation callback (_RemoteConversation).
    musterd_calls: int = 0


_ARM = threading.local()


def current_arm() -> ArmState | None:
    return getattr(_ARM, "state", None)


@contextlib.contextmanager
def arm(state: ArmState) -> Iterator[None]:
    """Mark this thread as running one of these arms for the duration of one agent's run."""
    previous = current_arm()
    _ARM.state = state
    try:
        yield
    finally:
        _ARM.state = previous


# ─────────────────────────── docker in place of Modal ───────────────────────────


def docker(*args: str, timeout: int = 120, check: bool = True) -> str:
    proc = subprocess.run(["docker", *args], capture_output=True, text=True, timeout=timeout)
    if check and proc.returncode != 0:
        raise RuntimeError(f"docker {' '.join(args[:2])} failed ({proc.returncode}): {proc.stderr[-800:]}")
    return proc.stdout


def docker_exec(container: str, command: str, *, timeout: int = 600, env: dict[str, str] | None = None) -> tuple[int, str]:
    env_args = [a for k, v in (env or {}).items() for a in ("-e", f"{k}={v}")]
    proc = subprocess.run(
        ["docker", "exec", *env_args, "-w", CONTAINER_REPO, container, "bash", "-lc", command],
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    return proc.returncode, proc.stdout + proc.stderr



def docker_run_args(
    image: str, *, name: str, port: int, env: dict[str, str], musterd: bool
) -> list[str]:
    """`docker run` for one agent-server: host network, loopback-only, the image's own entrypoint.

    The `-oh` image's ENTRYPOINT already passes `--host 0.0.0.0 --port 8000`; the trailing arguments
    override both (argparse keeps the last), so two agents on one host network don't collide and
    neither server listens beyond loopback.

    `-w /` as CooperBench's Modal sandbox (`workdir="/"`): the agent-server writes its state under
    `workspace/` in its cwd, and in the image's WORKDIR, the repo, `git add -A` put that state in the
    patch, which grew past what the eval can pass to `bash -c` ("Failed to write patch1.patch").

    `--init`, as Modal's sandbox has one: without it the agent-server is PID 1, so the musterd MCP
    server it spawns has ppid 1, which the adapter's session ladder (ADR 164) reads as "harness
    exited". It released the seat at its first heartbeat, 15 s in, and every musterd call, gate check
    and interrupt check after that failed.
    """
    args = ["run", "-d", "--rm", "--init", "--name", name, "--network=host", "-w", "/"]
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    if musterd:
        args += [
            "-v", f"{HOST_PACK_DIR}:{CONTAINER_PACK_DIR}:ro",
            "-v", f"{HOST_OH_DIR}:{CONTAINER_OH_DIR}:ro",
            # The interrupt slot, loaded into the agent-server's Python at startup.
            "-v", f"{HOST_OH_DIR}/musterd-oh-inbox.pth:{AGENT_SITE_PACKAGES}/musterd-oh-inbox.pth:ro",
        ]  # fmt: skip
    return [*args, image, "--host", "127.0.0.1", "--port", str(port)]


class DockerSandboxContext(oh.ModalSandboxContext):
    """CooperBench's ModalSandboxContext, run on the local docker daemon.

    Same image, same credentials (`_collect_credentials`, which also carries REDIS_URL, AGENT_ID and
    AGENTS for the plain coop arm), same health wait. Yields the agent-server's loopback URL.
    """

    def __enter__(self) -> str:
        state = current_arm()
        musterd = bool(state and state.mode == "musterd")
        env = self._collect_credentials()
        if musterd and state is not None and state.seat_env:
            env.update(state.seat_env)
            env["MUSTERD_OH_INTERRUPT"] = "1"
        port = free_port()
        self._container = f"cb-oh-{os.getpid()}-{port}"
        docker(*docker_run_args(self.image_name, name=self._container, port=port, env=env, musterd=musterd), timeout=900)
        url = f"http://127.0.0.1:{port}"
        self._wait_for_server(url)
        if musterd and state is not None:
            seat_up(self._container, state)
        return url

    def __exit__(self, exc_type, exc_val, exc_tb):
        if getattr(self, "_container", None):
            docker("rm", "-f", self._container, check=False, timeout=60)


# ─────────────────────────── the musterd seat in the container ───────────────────────────


def plugin_files(seat_env: dict[str, str], mcp_entry: str) -> dict[str, str]:
    """The OpenHands plugin that makes the agent a musterd seat: its manifest, gate hook and MCP server."""
    hooks = {
        "hooks": {
            "PreToolUse": [
                {
                    # Only the file editor is gated, as in the Claude Code arm (config.GATE_MATCHER): the
                    # gate matches a terminal call by its whole command, and `**` would refuse them all.
                    "matcher": "file_editor",
                    "hooks": [{"type": "command", "command": f"node {GATE_SHIM}", "timeout": 30}],
                }
            ]
        }
    }
    # Started from the repo: the adapter finds the seat's binding from its cwd, and only a binding
    # it found carries its live lease, which `inbox --interrupt-check` needs or reads as deaf.
    launch = f"cd {shlex.quote(CONTAINER_REPO)} && exec node {shlex.quote(mcp_entry)}"
    mcp = {"mcpServers": {"musterd": {"command": "sh", "args": ["-c", launch], "env": seat_env}}}
    manifest = {"name": "musterd", "version": "0.0.0", "description": "musterd seat: lane gate and team tools"}
    return {
        ".claude-plugin/plugin.json": json.dumps(manifest),
        "hooks/hooks.json": json.dumps(hooks),
        ".mcp.json": json.dumps(mcp),
    }


def write_in_container(container: str, path: str, content: str) -> None:
    proc = subprocess.run(
        ["docker", "exec", "-i", container, "sh", "-c", f"mkdir -p {shlex.quote(os.path.dirname(path))} && cat > {shlex.quote(path)}"],
        input=content,
        capture_output=True,
        text=True,
        timeout=60,
    )
    if proc.returncode != 0:
        raise RuntimeError(f"could not write {path} in the container: {proc.stderr[-400:]}")


def seat_up(container: str, state: ArmState) -> None:
    """Install musterd, admit the seat, keep its binding out of git, and write the plugin."""
    assert state.pair is not None and state.seat_env is not None
    code, out = docker_exec(container, INSTALL_NODE, timeout=900)
    if code != 0:
        raise RuntimeError("node install failed: " + out[-2000:])
    code, out = docker_exec(container, INSTALL_MUSTERD, timeout=600)
    if code != 0:
        _, log = docker_exec(container, "cat /tmp/musterd-install.log")
        raise RuntimeError("musterd install failed: " + log[-2000:])
    docker_exec(container, f"mkdir -p {CONTAINER_SEAT_HOME}")
    admit(container, state.pair, state.agent_id, state.seat_env)
    docker_exec(container, f"printf %s {shlex.quote(cfg.GIT_EXCLUDE)} >> {CONTAINER_REPO}/.git/info/exclude")
    code, npm_root = docker_exec(container, "npm root -g")
    npm_root = npm_root.strip().splitlines()[-1] if npm_root.strip() else ""
    if code != 0 or not npm_root.startswith("/"):
        raise RuntimeError(f"could not resolve npm's global root in the container: {npm_root[:200]}")
    mcp_entry = f"{npm_root}/{MCP_ENTRY_RELATIVE}"
    if docker_exec(container, f"test -f {shlex.quote(mcp_entry)}")[0] != 0:
        raise RuntimeError(f"musterd MCP entry missing in the container: {mcp_entry}")
    for rel, content in plugin_files(state.seat_env, mcp_entry).items():
        write_in_container(container, f"{PLUGIN_DIR}/{rel}", content)


def admit(container: str, pair: PairTeam, agent_id: str, seat_env: dict[str, str], timeout_s: float = 120) -> None:
    """config.admit_seat, with the blocking claim inside the container and the approval on the host."""
    host = cfg.Cli(pair.workdir, pair.port)
    key = pair.seats[agent_id].key
    subprocess.Popen(
        [
            "docker", "exec", *[a for k, v in seat_env.items() for a in ("-e", f"{k}={v}")],
            "-w", CONTAINER_REPO, container,
            "musterd", "claim", agent_id, "--team", pair.team, "--key", key,
        ],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )  # fmt: skip
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        pending = json.loads(host.run("requests", "--pending", "--json") or "[]")
        items = pending if isinstance(pending, list) else pending.get("requests", [])
        mine = [r for r in items if agent_id in json.dumps(r)]
        if mine:
            host.run("requests", "decide", mine[0]["id"], "--approve", "--once")
            break
        time.sleep(0.5)
    while time.monotonic() < deadline:
        if docker_exec(container, f"test -f {CONTAINER_REPO}/.musterd/binding.json")[0] == 0:
            return
        time.sleep(0.5)
    raise RuntimeError(f"{agent_id}: seat admission did not bind the repo")


def oh_seat_env(pair: PairTeam, agent_id: str) -> dict[str, str]:
    env = cfg.seat_env(pair, agent_id, home=CONTAINER_SEAT_HOME)
    env["MUSTERD_LAUNCH_SURFACE"] = OPENHANDS_SURFACE
    return env


# ─────────────────────────── the patches, each a no-op outside these arms ───────────────────────────

_ORIGINAL_NEEDS_MODAL_REDIS = oh._needs_modal_redis
_ORIGINAL_GET_GIT = oh._get_or_create_git_server
_ORIGINAL_RELEASE_GIT = oh._release_git_server
_ORIGINAL_SANDBOX = oh.ModalSandboxContext
_ORIGINAL_GET_DEFAULT_AGENT = oh_preset.get_default_agent
_ORIGINAL_REMOTE_CONVERSATION = oh_conversation.RemoteConversation


class _SandboxDispatch(_ORIGINAL_SANDBOX):
    def __new__(cls, *args: Any, **kwargs: Any):
        if current_arm() is not None:
            return DockerSandboxContext(*args, **kwargs)
        return _ORIGINAL_SANDBOX(*args, **kwargs)


def _needs_modal_redis(comm_url: str | None) -> bool:
    # In local docker with host networking, the runner's localhost Redis is reachable as it is.
    if current_arm() is not None:
        return False
    return _ORIGINAL_NEEDS_MODAL_REDIS(comm_url)


def _get_or_create_git_server(run_id: str, agents: list[str], timeout: int = 3600) -> str:
    state = current_arm()
    if state is None:
        return _ORIGINAL_GET_GIT(run_id, agents, timeout)
    if not state.git_url:
        raise RuntimeError("--git was asked for but the runner provided no git server")
    return state.git_url


def _release_git_server(run_id: str) -> None:
    # The runner owns its docker git server; these arms never created one.
    if current_arm() is None:
        _ORIGINAL_RELEASE_GIT(run_id)


def musterd_agent(llm: Any, state: ArmState, *, cli_mode: bool = True) -> Any:
    """CooperBench's default agent, minus the Redis messaging tools, with the musterd section in the
    system prompt's collaboration slot (where the plain arm's section goes)."""
    agent = _ORIGINAL_GET_DEFAULT_AGENT(llm=llm, cli_mode=cli_mode, coop_info=None)
    teammates = [a for a in state.agents if a != state.agent_id]
    kwargs = {**agent.system_prompt_kwargs, "collaboration": musterd_system_section(state.agent_id, teammates, state.git_enabled)}
    tools = [t for t in agent.tools if t.name not in OH_MESSAGING_TOOLS]
    return agent.model_copy(update={"system_prompt_kwargs": kwargs, "tools": tools})


def _get_default_agent(llm: Any, cli_mode: bool = False, coop_info: dict | None = None) -> Any:
    state = current_arm()
    if state is not None:
        # Both arms, alike: OpenHands defaults Anthropic models to extended thinking, and on a long run
        # it replays an assistant message that ends in a thinking block, which the API refuses ("The
        # final block in an assistant message cannot be `thinking`"). oh-coop's agent2 died on it.
        llm = llm.model_copy(update={"extended_thinking_budget": None})
    if state is not None and state.mode == "musterd":
        return musterd_agent(llm, state, cli_mode=cli_mode)
    return _ORIGINAL_GET_DEFAULT_AGENT(llm=llm, cli_mode=cli_mode, coop_info=coop_info)


def is_musterd_call(event: Any) -> bool:
    tool = getattr(event, "tool_name", None)
    return type(event).__name__ == "ActionEvent" and isinstance(tool, str) and tool.startswith(MUSTERD_TOOL_PREFIXES)


class _RemoteConversation(_ORIGINAL_REMOTE_CONVERSATION):
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        state = current_arm()
        if state is not None and state.mode == "musterd":
            kwargs["plugins"] = [*(kwargs.get("plugins") or []), PluginSource(source=PLUGIN_DIR)]

            # Callbacks fire on the websocket thread, so the state is captured here, not looked up.
            def count_musterd_calls(event: Any, state: ArmState = state) -> None:
                if is_musterd_call(event):
                    state.musterd_calls += 1

            kwargs["callbacks"] = [*(kwargs.get("callbacks") or []), count_musterd_calls]
        super().__init__(*args, **kwargs)


def install_patches() -> None:
    oh.ModalSandboxContext = _SandboxDispatch
    oh._needs_modal_redis = _needs_modal_redis
    oh._get_or_create_git_server = _get_or_create_git_server
    oh._release_git_server = _release_git_server
    oh_preset.get_default_agent = _get_default_agent
    oh_conversation.RemoteConversation = _RemoteConversation


install_patches()


# ─────────────────────────── the runners ───────────────────────────


@register("openhands_sdk_docker")
class OpenHandsDockerRunner(oh.OpenHandsSDKRunner):
    """CooperBench's coop setting on OpenHands, in local docker: the plain arm."""

    def run(self, task: str, image: str, *, git_server_url: str | None = None, **kwargs: Any):
        state = ArmState(mode="docker", git_url=host_reachable_git_url(git_server_url))
        with arm(state):
            return super().run(task, image, git_server_url=git_server_url, **kwargs)


@register("openhands_sdk_musterd")
class OpenHandsMusterdRunner(oh.OpenHandsSDKRunner):
    """CooperBench's coop setting on OpenHands, in local docker, coordinating through musterd."""

    def run(
        self,
        task: str,
        image: str,
        *,
        agent_id: str = "agent",
        agents: list[str] | None = None,
        git_server_url: str | None = None,
        git_enabled: bool = False,
        config: dict | None = None,
        log_dir: str | None = None,
        **kwargs: Any,
    ):
        config = config or {}
        agents = list(agents or [agent_id])
        run_id = str(config.get("run_id") or "solo")
        kwargs.pop("comm_url", None)
        kwargs.pop("messaging_enabled", None)
        pair = REGISTRY.acquire(run_id, agents)
        state = ArmState(
            mode="musterd",
            git_url=host_reachable_git_url(git_server_url),
            agent_id=agent_id,
            agents=tuple(agents),
            git_enabled=bool(git_enabled and git_server_url and len(agents) > 1),
            pair=pair,
            seat_env=oh_seat_env(pair, agent_id),
        )
        try:
            with arm(state):
                result = super().run(
                    task,
                    image,
                    agent_id=agent_id,
                    agents=agents,
                    # No Redis: musterd is this arm's only channel.
                    comm_url=None,
                    messaging_enabled=False,
                    git_server_url=git_server_url,
                    git_enabled=git_enabled,
                    config=config,
                    log_dir=log_dir,
                    **kwargs,
                )
        finally:
            REGISTRY.release(run_id, keep_logs_in=Path(log_dir) if log_dir else None)
        # A run that never made a musterd call is not a musterd arm: the MCP server didn't load, or
        # the agent never used it, and either way the gate was never armed (the Claude Code arm's
        # first e2e run scored that way, 2026-10-20). Fail it instead of letting it score.
        if result.error is None and state.musterd_calls == 0:
            result.status = "Error"
            result.error = "no musterd tool call in the run: the musterd MCP server did not load or was never used"
        return result
