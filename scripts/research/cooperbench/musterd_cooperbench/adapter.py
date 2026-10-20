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
from .team import CONTAINER_NETWORK_ARGS, REGISTRY

logger = logging.getLogger(__name__)

# Where the packed tarballs live on the host, and where the container sees them.
HOST_PACK_DIR = os.environ.get("MUSTERD_PACK_DIR", "/opt/musterd-pack")
CONTAINER_PACK_DIR = "/opt/musterd-pack"
CONTAINER_SEAT_HOME = "/tmp/musterd-seat"
CONTAINER_MCP_CONFIG = "/tmp/musterd-mcp.json"
CONTAINER_SETTINGS = f"{cc.CONTAINER_CLAUDE_CONFIG_DIR}/settings.json"
CONTAINER_MCP_ENTRY = "/usr/local/lib/node_modules/@musterd/mcp/dist/index.js"

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


@register("claude_code_musterd")
class ClaudeCodeMusterdRunner:
    """CooperBench's coop setting on Claude Code, coordinating through musterd."""

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
        stream_text = session_text = patch_text = ""
        try:
            # 1. Claude Code, exactly as CooperBench installs it; then the packed musterd.
            write_file_in_container(env, CONTAINER_SETUP_PATH, cc.SETUP_SCRIPT_PATH.read_text())
            install = env.execute({"command": f"bash {shlex.quote(CONTAINER_SETUP_PATH)}"}, timeout=600)
            if install.get("returncode") not in (0, None):
                raise RuntimeError("claude-code install failed: " + (install.get("output") or "")[:2000])
            installed = env.execute({"command": INSTALL_MUSTERD}, timeout=600)
            if installed.get("returncode") not in (0, None):
                log = read_file_from_container(env, "/tmp/musterd-install.log")
                raise RuntimeError("musterd install failed: " + log[-2000:])

            # 2. The seat: admitted, its binding kept out of git, its MCP server and hooks wired.
            env.execute({"command": f"mkdir -p {CONTAINER_SEAT_HOME} {cc.CONTAINER_CLAUDE_CONFIG_DIR}"}, timeout=30)
            _admit_in_container(env, pair, agent_id, seat_exports)
            env.execute(
                {"command": f"printf %s {shlex.quote(cfg.GIT_EXCLUDE)} >> {CONTAINER_REPO_PATH}/.git/info/exclude"},
                timeout=30,
            )
            write_file_in_container(
                env,
                CONTAINER_MCP_CONFIG,
                json.dumps(cfg.mcp_config(seat_env, command="node", args=[CONTAINER_MCP_ENTRY])),
            )
            write_file_in_container(env, CONTAINER_SETTINGS, json.dumps(cfg.claude_settings(settings_env or None)))

            # 3. The shared git remote, when the run uses one (CooperBench's own setup).
            if use_git:
                git_setup = env.execute(
                    {"command": build_git_setup_command(agent_id=agent_id, server_url=git_server_url or "")},
                    timeout=120,
                )
                if git_setup.get("returncode") not in (0, None):
                    logger.warning("git setup returned non-zero: %s", (git_setup.get("output") or "")[:500])

            # 4. The instruction and the run.
            instruction = build_instruction(task, agents=agents, agent_id=agent_id, git_enabled=use_git)
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
            env.execute({"command": 'export PATH="/usr/local/bin:$PATH"; ' + invoke}, timeout=7200)

            # 5. CooperBench's outputs.
            stream_text = read_file_from_container(env, cc.CONTAINER_STREAM_LOG)
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
