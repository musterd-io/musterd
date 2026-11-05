"""`claude_code_musterd`: CooperBench's Claude Code adapter, with musterd as the coordination layer.

Load it with ``COOPERBENCH_EXTERNAL_AGENTS=musterd_cooperbench`` and run
``cooperbench run --setting coop -a claude_code_musterd …``. The run is CooperBench's coop setting
in every respect but one: instead of the Redis ``coop-*`` commands, each agent is a seat on a fresh
musterd team (team.py), coordinates through the musterd MCP tools, and edits only inside lanes it
claimed (the ADR 150 gate, as config.py wires it). Everything else — the task image, the Claude
Code install, the git remote, the submission protocol, patch harvesting, cost parsing — is
CooperBench's own code at commit 63b9d44, called rather than copied where it is importable.

The run happens on a Linux host with docker (the Fly VM, deploy/cooperbench/). Each container runs
with `--network=host` so it reaches the daemon on the host's loopback (team.py explains why), and
mounts the packed musterd CLI and MCP server read-only (pack.sh).
"""

from __future__ import annotations

import json
import logging
import os
import shlex
import time
from pathlib import Path
from typing import Any

from cooperbench.agents import AgentResult
from cooperbench.agents._coop import build_git_setup_command
from cooperbench.agents._coop.runtime import (
    CONTAINER_INSTRUCTION_PATH,
    CONTAINER_REPO_PATH,
    CONTAINER_SETUP_PATH,
    normalize_patch,
    read_file_from_container,
    write_file_in_container,
)
from cooperbench.agents.claude_code import adapter as cc
from cooperbench.agents.claude_code.parsers import parse_session_jsonl, parse_stream_json
from cooperbench.agents.registry import register

from . import config as cfg
from .prompt import build_instruction
from .team import CONTAINER_NETWORK_ARGS, REGISTRY, act_lane, host_reachable_git_url

logger = logging.getLogger(__name__)

# The agent must be able to reach the shared remote it is told about: `team` lists its refs.
GIT_REMOTE_PROBE = "git -C /workspace/repo ls-remote --heads team >/dev/null"

# Where the packed tarballs live on the host, and where the container sees them.
HOST_PACK_DIR = os.environ.get("MUSTERD_PACK_DIR", "/opt/musterd-pack")
CONTAINER_PACK_DIR = "/opt/musterd-pack"
CONTAINER_SEAT_HOME = "/tmp/musterd-seat"
CONTAINER_MCP_CONFIG = "/tmp/musterd-mcp.json"
CONTAINER_SETTINGS = f"{cc.CONTAINER_CLAUDE_CONFIG_DIR}/settings.json"
# The MCP server is launched by its real file, never the npm bin symlink (#2974 fixed that, but the
# file is the one path that cannot regress). Where npm puts global modules depends on how the task
# image installed Node (nodesource on Debian: /usr/lib/node_modules), so it is resolved in the
# container. The first e2e run hard-coded /usr/local/... and the MCP server failed to start.
MCP_ENTRY_RELATIVE = "@musterd/mcp/dist/index.js"

# Rider 7 (the act lane, docs/research/cooperbench/rider7-manifest.md). The pair's admin binding is
# copied into the container so `musterd residency on` can be authorized there (ADR 442: who
# authorizes is the folder you run from); the seat's own binding in the repo receives the grant and
# the host-registry entry, as on any machine. `musterd host` then runs in the container, where the
# harness and the repo are, under its own host label so its leases are its own.
CONTAINER_ADMIN_HOME = "/tmp/musterd-admin"
CONTAINER_HOST_REGISTRY = f"{CONTAINER_SEAT_HOME}/host-registry.json"
CONTAINER_HOST_LOG = "/tmp/musterd-host.log"
CONTAINER_LOCAL_SETTINGS = f"{CONTAINER_REPO_PATH}/.claude/settings.local.json"
# The run's wall clock (the same 7,200 s the first call has today), the poll, and how long the seat
# must be quiet — patch written, nothing unread — before the adapter stops waiting for wakes.
ACT_RUN_SECONDS = 7200
ACT_POLL_SECONDS = 30
ACT_QUIET_SECONDS = 300
# Both seats idle with nothing unread and no harness process for this long is the end of the pair
# whether or not a patch was written: the re-run's first smoke pair (2026-11-05) sat 25 minutes in
# exactly that state — each agent had ended its turn waiting for the other, no act was in flight, so
# no wake was due — and would have run to the 7,200 s cap. What is read then is whatever is there.
ACT_IDLE_SECONDS = 600
# A harness process is live in the container (no `ps` in the task images; /proc is read directly).
HARNESS_LIVE_PROBE = "grep -lq claude /proc/[0-9]*/cmdline 2>/dev/null"
# musterd's self-heal (the interrupt hook, and the host before a wake) refreshes a workspace's hooks
# to musterd's own set, whose gate matcher includes Bash. The arm gates the file tools only (README:
# with `**` the gate matched every shell command), so the tombstone that turns self-heal off for one
# folder is written beside the binding. A product knob, not a bypass: `musterd:self-heal`.
SELF_HEAL_TOMBSTONE = {
    "version": 1,
    "declined": [{"surface": "musterd:self-heal", "at": "2026-11-05T00:00:00Z", "by": "cooperbench arm"}],
}


def host_label(pair: Any, agent_id: str) -> str:
    return f"cb-{pair.run_id}-{agent_id}"


def unread_directed(delivery_json: str, agent_id: str) -> int:
    """Directed acts to this seat that no session has seen, from `musterd report delivery --json`."""
    try:
        acts = json.loads(delivery_json or "[]")
    except json.JSONDecodeError:
        return 0
    if isinstance(acts, dict):
        acts = acts.get("delivery") or acts.get("acts") or []
    n = 0
    for act in acts:
        for r in act.get("recipients") or []:
            if r.get("seat") == agent_id and r.get("state") == "logged":
                n += 1
    return n

# musterd's CLI refuses Node under 22. CooperBench's setup.sh installs Node from apk on an Alpine
# image, and Alpine 3.20's newest package is Node 21 (`go_chi` task 27: v20.15.1, pilot 2026-10-21,
# both agents refused at seat admission). So on an Alpine image an official musl build of Node 22
# goes in front of it. Claude Code, installed by setup.sh a moment earlier, runs on it too. Debian
# images get Node 22 from nodesource in setup.sh and skip this. One pinned build, x86_64 only: the
# run machine's architecture, and the only one the pilot measures.
NODE22_MUSL_VERSION = "v22.23.3"
ENSURE_NODE22 = (
    'major=$(node -p "process.versions.node.split(\\".\\")[0]" 2>/dev/null || echo 0); '
    'if [ "$major" -lt 22 ] && command -v apk >/dev/null 2>&1 && [ "$(uname -m)" = x86_64 ]; then '
    "apk add --no-cache curl xz >/dev/null 2>&1 && "
    f"curl -fsSL https://unofficial-builds.nodejs.org/download/release/{NODE22_MUSL_VERSION}/"
    f"node-{NODE22_MUSL_VERSION}-linux-x64-musl.tar.xz | tar -xJ -C /usr/local --strip-components=1; "
    "fi; node -v"
)

INSTALL_MUSTERD = (
    f"npm install -g --ignore-scripts --no-audit --no-fund {CONTAINER_PACK_DIR}/musterd-*.tgz "
    "> /tmp/musterd-install.log 2>&1 && command -v musterd"
)


def _admit_in_container(env: Any, pair: Any, agent_id: str, seat_exports: str, timeout_s: float = 120) -> None:
    """config.admit_seat, with the claim running inside the container and the approval on the host."""
    host = cfg.Cli(pair.workdir, pair.port)
    key = pair.seats[agent_id].key
    env.execute(
        {
            "command": seat_exports
            + f"cd {CONTAINER_REPO_PATH} && nohup musterd claim {shlex.quote(agent_id)} "
            f"--team {shlex.quote(pair.team)} --key {shlex.quote(key)} > /tmp/musterd-claim.log 2>&1 &"
        },
        timeout=30,
    )
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
        probe = env.execute({"command": f"test -f {CONTAINER_REPO_PATH}/.musterd/binding.json"}, timeout=30)
        if probe.get("returncode") == 0:
            return
        time.sleep(0.5)
    log = read_file_from_container(env, "/tmp/musterd-claim.log")
    raise RuntimeError(f"{agent_id}: seat admission did not bind the repo: {log[-400:]}")


def musterd_mcp_status(stream_text: str) -> str:
    """The musterd MCP server's status in Claude Code's stream-json init event, or "absent"."""
    for line in stream_text.splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if event.get("type") == "system" and event.get("subtype") == "init":
            for server in event.get("mcp_servers") or []:
                if server.get("name") == "musterd":
                    return str(server.get("status"))
            return "absent"
    return "absent"


@register("claude_code_musterd")
class ClaudeCodeMusterdRunner:
    """CooperBench's coop setting on Claude Code, coordinating through musterd."""

    def _wire_act_lane(
        self,
        env: Any,
        pair: Any,
        agent_id: str,
        seat_env: dict[str, str],
        seat_exports: str,
        settings: dict[str, Any],
        mcp_entry: str,
    ) -> None:
        """Rider 7: enroll the seat on the act lane from inside its container.

        1. The settings a wake reads: `.claude/settings.local.json` in the repo (hooks, the capture
           hooks, the permission floor), identical to the `--settings` file the first call gets.
        2. The MCP server a wake loads: `claude mcp add -s local`, keyed by the repo root (ADR 165),
           the same command, entry and seat env as `--mcp-config`.
        3. The admin binding, copied from the pair's host workdir, so `residency on` is authorized.
        4. `residency on --seat <agent> --workspace /workspace/repo --host <label>`: the enrollment
           row on the daemon, the standing grant and host key in the seat's binding, and the
           host-registry entry (seat → workspace) the host actuates from.
        """
        env.execute({"command": f"mkdir -p {CONTAINER_REPO_PATH}/.claude {CONTAINER_ADMIN_HOME}/.musterd"}, timeout=30)
        write_file_in_container(env, CONTAINER_LOCAL_SETTINGS, json.dumps(settings))
        write_file_in_container(env, f"{CONTAINER_REPO_PATH}/.musterd/declined.json", json.dumps(SELF_HEAL_TOMBSTONE))
        mcp_env = {k: v for k, v in seat_env.items() if k != "PATH"}
        env_args = " ".join(f"-e {shlex.quote(f'{k}={v}')}" for k, v in mcp_env.items())
        added = env.execute(
            {
                "command": f'export PATH="/usr/local/bin:$PATH"; cd {CONTAINER_REPO_PATH} && '
                f"claude mcp remove musterd -s local >/dev/null 2>&1; "
                f"claude mcp add musterd -s local {env_args} -- node {shlex.quote(mcp_entry)}"
            },
            timeout=60,
        )
        if added.get("returncode") not in (0, None):
            raise RuntimeError("claude mcp add failed in the container: " + (added.get("output") or "")[-500:])
        admin_binding = (pair.workdir / ".musterd" / "binding.json").read_text()
        admin_config = (pair.workdir / "config.json").read_text() if (pair.workdir / "config.json").exists() else "{}"
        write_file_in_container(env, f"{CONTAINER_ADMIN_HOME}/.musterd/binding.json", admin_binding)
        write_file_in_container(env, f"{CONTAINER_ADMIN_HOME}/config.json", admin_config)
        admin_exports = (
            f"export MUSTERD_CONFIG={CONTAINER_ADMIN_HOME}/config.json; "
            f"export MUSTERD_SERVER={shlex.quote(pair.container_url)}; "
            f"export MUSTERD_HOST_REGISTRY={CONTAINER_HOST_REGISTRY}; "
        )
        enrolled = env.execute(
            {
                "command": 'export PATH="/usr/local/bin:$PATH"; ' + admin_exports + f"cd {CONTAINER_ADMIN_HOME} && "
                f"musterd residency on --seat {shlex.quote(agent_id)} --workspace {CONTAINER_REPO_PATH} "
                f"--harness claude-code --host {shlex.quote(host_label(pair, agent_id))} > /tmp/musterd-enroll.log 2>&1"
            },
            timeout=120,
        )
        if enrolled.get("returncode") not in (0, None):
            log = read_file_from_container(env, "/tmp/musterd-enroll.log")
            raise RuntimeError(f"{agent_id}: residency on failed: {log[-800:]}")
        probe = env.execute({"command": f"test -s {CONTAINER_HOST_REGISTRY}"}, timeout=30)
        if probe.get("returncode") not in (0, None):
            log = read_file_from_container(env, "/tmp/musterd-enroll.log")
            raise RuntimeError(f"{agent_id}: residency on wrote no host-registry entry: {log[-800:]}")

    def _start_host(
        self, env: Any, pair: Any, agent_id: str, seat_exports: str, cred_exports: str, model_name: str
    ) -> None:
        """Rider 7: the wake actuator, in the container, under this seat's own host label.

        `--no-provision` (no sponsor here), `--no-gateway` (the wake's own `total_cost_usd` is the
        price, as the first call's is), `--interval 10` (the design note's poll), `--timeout 3600`
        (the team policy's bound). Never a skip-permissions flag: that is the host's invariant.
        """
        env.execute(
            {
                "command": 'export PATH="/usr/local/bin:$PATH"; ' + seat_exports + cred_exports
                + f"export MUSTERD_HOST_REGISTRY={CONTAINER_HOST_REGISTRY}; "
                + f"export ANTHROPIC_MODEL={shlex.quote(model_name)}; "
                + f"cd {CONTAINER_REPO_PATH} && nohup musterd host --host {shlex.quote(host_label(pair, agent_id))} "
                f"--interval 10 --timeout 3600 --no-provision --no-gateway > {CONTAINER_HOST_LOG} 2>&1 &"
            },
            timeout=30,
        )

    def _wait_for_act_lane(self, env: Any, pair: Any, agent_id: str, *, deadline: float) -> None:
        host = cfg.Cli(pair.workdir, pair.port)
        quiet_since: float | None = None
        idle_since: float | None = None
        while time.monotonic() < deadline:
            patch = env.execute({"command": f"test -s {CONTAINER_REPO_PATH}/patch.txt"}, timeout=30)
            unread = 0
            try:
                unread = unread_directed(host.run("report", "delivery", "--json"), agent_id)
            except Exception:  # noqa: BLE001 — a failed read is "not quiet", never an exit
                unread = 1
            live = env.execute({"command": HARNESS_LIVE_PROBE}, timeout=30).get("returncode") in (0, None)
            quiet = patch.get("returncode") in (0, None) and unread == 0
            idle = unread == 0 and not live
            now = time.monotonic()
            quiet_since = (quiet_since if quiet_since is not None else now) if quiet else None
            idle_since = (idle_since if idle_since is not None else now) if idle else None
            if quiet_since is not None and now - quiet_since >= ACT_QUIET_SECONDS:
                return
            if idle_since is not None and now - idle_since >= ACT_IDLE_SECONDS:
                return
            time.sleep(min(ACT_POLL_SECONDS, max(0.0, deadline - now)))

    def run(
        self,
        task: str,
        image: str,
        *,
        agent_id: str = "agent",
        model_name: str = "claude-sonnet-4-5",
        agents: list[str] | None = None,
        git_server_url: str | None = None,
        git_enabled: bool = False,
        config: dict | None = None,
        log_dir: str | None = None,
        **kwargs: Any,
    ) -> AgentResult:
        config = config or {}
        agents = list(agents or [agent_id])
        run_id = str(config.get("run_id") or "solo")
        use_git = bool(git_enabled and git_server_url and len(agents) > 1)
        credentials = cc.resolve_credentials()
        endpoint_overrides = cc.resolve_endpoint_overrides()

        pair = REGISTRY.acquire(run_id, agents)
        seat_env = cfg.seat_env(pair, agent_id, home=CONTAINER_SEAT_HOME)
        seat_env["PATH"] = "/usr/local/bin:/usr/bin:/bin:$HOME/.local/bin"
        seat_exports = "".join(f"export {k}={shlex.quote(v)}; " for k, v in seat_env.items() if k != "PATH")
        seat_exports += 'export PATH="/usr/local/bin:$PATH"; '

        settings_env, disallowed_tools = cc._resolve_runtime_limits(
            model_name, config, endpoint_overrides=endpoint_overrides
        )
        extra_flags = f"--mcp-config {CONTAINER_MCP_CONFIG} --strict-mcp-config "
        if config.get("max_turns"):
            extra_flags += f"--max-turns {int(config['max_turns'])} "
        if disallowed_tools:
            extra_flags += f"--disallowedTools {shlex.quote(','.join(disallowed_tools))} "

        run_args = [
            *CONTAINER_NETWORK_ARGS,
            "--add-host=host.docker.internal:host-gateway",
            "-v",
            f"{HOST_PACK_DIR}:{CONTAINER_PACK_DIR}:ro",
        ]
        env = cc._build_environment(
            image,
            network=None,
            extra_run_args=run_args,
            backend=config.get("backend", "docker"),
        )

        status, error_msg = "Error", None
        stream_text = session_text = patch_text = host_text = ""
        try:
            # 1. Claude Code, exactly as CooperBench installs it; then the packed musterd.
            write_file_in_container(env, CONTAINER_SETUP_PATH, cc.SETUP_SCRIPT_PATH.read_text())
            install = env.execute({"command": f"bash {shlex.quote(CONTAINER_SETUP_PATH)}"}, timeout=600)
            if install.get("returncode") not in (0, None):
                raise RuntimeError("claude-code install failed: " + (install.get("output") or "")[:2000])
            node = env.execute({"command": ENSURE_NODE22}, timeout=600)
            node_line = (node.get("output") or "").strip().splitlines()[-1:] or [""]
            if node.get("returncode") not in (0, None) or not node_line[0].startswith("v"):
                raise RuntimeError("node check failed: " + (node.get("output") or "")[-500:])
            installed = env.execute({"command": INSTALL_MUSTERD}, timeout=600)
            if installed.get("returncode") not in (0, None):
                log = read_file_from_container(env, "/tmp/musterd-install.log")
                raise RuntimeError("musterd install failed: " + log[-2000:])

            # 2. The seat: admitted, its binding kept out of git, its MCP server and hooks wired.
            env.execute({"command": f"mkdir -p {CONTAINER_SEAT_HOME} {cc.CONTAINER_CLAUDE_CONFIG_DIR}"}, timeout=30)
            _admit_in_container(env, pair, agent_id, seat_exports)
            env.execute(
                {
                    "command": f"printf %s {shlex.quote(cfg.GIT_EXCLUDE_ACT if act_lane() else cfg.GIT_EXCLUDE)} "
                    f">> {CONTAINER_REPO_PATH}/.git/info/exclude"
                },
                timeout=30,
            )
            npm_root = (env.execute({"command": "npm root -g"}, timeout=60).get("output") or "").strip()
            if not npm_root.startswith("/"):
                raise RuntimeError(f"could not resolve npm's global root in the container: {npm_root[:200]}")
            mcp_entry = f"{npm_root}/{MCP_ENTRY_RELATIVE}"
            probe = env.execute({"command": f"test -f {shlex.quote(mcp_entry)}"}, timeout=30)
            if probe.get("returncode") not in (0, None):
                raise RuntimeError(f"musterd MCP entry missing in the container: {mcp_entry}")
            write_file_in_container(
                env,
                CONTAINER_MCP_CONFIG,
                json.dumps(cfg.mcp_config(seat_env, command="node", args=[mcp_entry])),
            )
            lane = "act" if act_lane() else "launch"
            settings = cfg.claude_settings(settings_env or None, lane=lane)
            write_file_in_container(env, CONTAINER_SETTINGS, json.dumps(settings))
            if lane == "act":
                self._wire_act_lane(env, pair, agent_id, seat_env, seat_exports, settings, mcp_entry)

            # 3. The shared git remote, when the run uses one (CooperBench's own setup). This
            # container is on the host's network, where the git server's container name does not
            # resolve, so the URL is its bridge IP, as in the OpenHands arms. Until 2026-10-21 it was
            # the name, every musterd agent's fetch and push failed, and a failed setup was only a
            # warning (finding 016 correction). A remote the agent cannot reach is now an error,
            # re-run once, never a score — the same rule as an unconnected MCP server.
            if use_git:
                git_setup = env.execute(
                    {
                        "command": build_git_setup_command(
                            agent_id=agent_id, server_url=host_reachable_git_url(git_server_url) or ""
                        )
                    },
                    timeout=120,
                )
                reach = env.execute({"command": GIT_REMOTE_PROBE}, timeout=60)
                if git_setup.get("returncode") not in (0, None) or reach.get("returncode") not in (0, None):
                    raise RuntimeError(
                        "shared git remote unreachable from the agent container: "
                        + ((reach.get("output") or git_setup.get("output") or "")[:300])
                    )

            # 4. The instruction and the run.
            instruction = build_instruction(
                task, agents=agents, agent_id=agent_id, git_enabled=use_git, lane="act" if act_lane() else "launch"
            )
            write_file_in_container(env, CONTAINER_INSTRUCTION_PATH, instruction)
            cred_env = {**credentials, **endpoint_overrides}
            cred_exports = "".join(f"export {k}={shlex.quote(v)}; " for k, v in cred_env.items())
            invoke = cred_exports + cc._build_claude_command(
                CONTAINER_INSTRUCTION_PATH,
                model_name,
                cc.CONTAINER_STREAM_LOG,
                extra_flags=extra_flags,
                coop_env={k: v for k, v in seat_env.items() if k != "PATH"},
                preserve_model_name=bool(endpoint_overrides),
                settings_path=CONTAINER_SETTINGS,
            )
            started = time.monotonic()
            if act_lane():
                # The host must see the model credential and the same model as the first call: a wake
                # is its own `claude` process, spawned by the host from the host's environment.
                self._start_host(env, pair, agent_id, seat_exports, cred_exports, model_name)
            env.execute({"command": 'export PATH="/usr/local/bin:$PATH"; ' + invoke}, timeout=ACT_RUN_SECONDS)
            if act_lane():
                # The first call ended at the agent's first idle turn; the act lane carries on from
                # here. Wait until the seat is done — patch written, nothing unread, quiet for a
                # while — or the run's wall clock, as the first call alone had today.
                self._wait_for_act_lane(env, pair, agent_id, deadline=started + ACT_RUN_SECONDS)

            # 5. CooperBench's outputs.
            stream_text = read_file_from_container(env, cc.CONTAINER_STREAM_LOG)
            host_text = read_file_from_container(env, CONTAINER_HOST_LOG) if act_lane() else ""
            # A run whose musterd MCP server never connected is not a musterd arm: the agent had no
            # musterd tools, and the gate failed open. Fail it loudly instead of letting it score
            # (the first e2e run, 2026-10-20, scored that way).
            mcp_status = musterd_mcp_status(stream_text)
            if mcp_status != "connected":
                raise RuntimeError(f"musterd MCP server was not connected at session start (status: {mcp_status})")
            session_text = cc._find_session_jsonl(env)
            patch_text = normalize_patch(read_file_from_container(env, f"{CONTAINER_REPO_PATH}/patch.txt"))
        except Exception as e:  # noqa: BLE001 — recorded on the result, as the base adapter does
            error_msg = str(e)
            logger.exception("claude_code_musterd run failed")
        finally:
            try:
                env.cleanup()
            except Exception:  # noqa: BLE001
                logger.warning("env cleanup failed", exc_info=True)
            REGISTRY.release(run_id, keep_logs_in=Path(log_dir) if log_dir else None)

        summary = parse_stream_json(stream_text)
        if log_dir:
            root = Path(log_dir)
            root.mkdir(parents=True, exist_ok=True)
            (root / f"{agent_id}_stream.jsonl").write_text(stream_text)
            (root / f"{agent_id}_session.jsonl").write_text(session_text)
            if act_lane():
                (root / f"{agent_id}_host.log").write_text(host_text)
        return AgentResult(
            status="Error" if error_msg is not None else summary.status,
            patch=patch_text,
            cost=summary.cost,
            steps=summary.steps,
            input_tokens=summary.input_tokens,
            output_tokens=summary.output_tokens,
            cache_read_tokens=summary.cache_read_tokens,
            cache_write_tokens=summary.cache_write_tokens,
            messages=parse_session_jsonl(session_text),
            sent_messages=[],
            error=error_msg,
        )
