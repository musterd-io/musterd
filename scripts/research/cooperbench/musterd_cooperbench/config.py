"""What one seat needs to run as a musterd teammate inside Claude Code: env, admission, MCP, hooks.

Shared by the CooperBench adapter (inside the agent container) and gate_smoke.py (on the host). The
hook commands are musterd's own, copied verbatim from packages/cli/src/onboard/harnesses/claudeCode.ts
(test_config.py fails if they drift), so the arm measures musterd as it ships, not a lookalike.
"""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any

from .team import Cli, PairTeam

# musterd's PreToolUse lane gate (ADR 150) and PostToolUse interrupt check (ADR 088), as
# claudeCode.ts writes them. The interrupt hook is how a busy seat sees an act addressed to it
# between tool calls; without it the arm would only hear its partner when it polled.
GATE_HOOK = (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; '
    "command -v musterd >/dev/null 2>&1 && musterd gate check --stdin 2>/dev/null || true "
    "# musterd-gate-hook"
)
INTERRUPT_HOOK = (
    'd="${CLAUDE_PROJECT_DIR:-.}"; cd "$d" 2>/dev/null; '
    "command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check --hook claude-code 2>/dev/null || true "
    "# musterd-interrupt-hook"
)
GATE_MATCHER = "Edit|Write|MultiEdit|NotebookEdit|Bash"

# musterd keeps the seat binding (and the gate's session markers) in `.musterd/` at the repo root.
# Excluding it in .git/info/exclude keeps it out of `git diff` and `git add -A`, so it can never
# reach the patch CooperBench scores; nothing the agent can see in the repo changes.
GIT_EXCLUDE = ".musterd/\n"


def seat_env(pair: PairTeam, agent_id: str, *, home: Path | str) -> dict[str, str]:
    """Environment for every musterd process acting as this seat (CLI, MCP server, hooks)."""
    return {
        "MUSTERD_SERVER": pair.container_url,
        "MUSTERD_LAUNCH_SURFACE": "claude-code",
        # The seat's own machine config, never the host's (a container has its own HOME anyway).
        "MUSTERD_CONFIG": f"{home}/musterd-config.json",
        # Read by the MCP server's config resolution (mcp/src/config.ts) and by `musterd claim`.
        "MUSTERD_TEAM": pair.team,
        "MUSTERD_CLAIM": f"seat:{agent_id}",
    }


def mcp_config(env: dict[str, str], *, command: str, args: list[str] | None = None) -> dict[str, Any]:
    """`--mcp-config` JSON for Claude Code: the musterd MCP server, and nothing else."""
    return {"mcpServers": {"musterd": {"type": "stdio", "command": command, "args": args or [], "env": env}}}


def claude_settings(extra_env: dict[str, str] | None = None) -> dict[str, Any]:
    """`--settings` JSON: musterd's gate and interrupt hooks (plus any env CooperBench already sets)."""
    settings: dict[str, Any] = {
        "hooks": {
            "PreToolUse": [{"matcher": GATE_MATCHER, "hooks": [{"type": "command", "command": GATE_HOOK}]}],
            "PostToolUse": [{"matcher": "*", "hooks": [{"type": "command", "command": INTERRUPT_HOOK}]}],
        }
    }
    if extra_env:
        settings["env"] = dict(extra_env)
    return settings


_REQUEST_ID = re.compile(r"\b([0-9A-HJKMNP-TV-Z]{26})\b")


def admit_seat(
    host: Cli,
    pair: PairTeam,
    agent_id: str,
    *,
    cwd: Path,
    env: dict[str, str],
    musterd: str = "musterd",
    timeout_s: float = 60.0,
) -> None:
    """Admit the seat the way a real seat is admitted: a blocking claim, approved by the host admin.

    A bootstrap key only claims (ADR 439); the seat credential arrives on the claim session that is
    waiting when the admin approves. `--detach` would leave no session to receive it. The approval
    is `--once`: single-use, for this run only.
    """
    claim = subprocess.Popen(
        [musterd, "claim", agent_id, "--team", pair.team, "--key", pair.seats[agent_id].key],
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    deadline = time.monotonic() + timeout_s
    request_id: str | None = None
    while request_id is None and time.monotonic() < deadline:
        pending = json.loads(host.run("requests", "--pending", "--json") or "[]")
        items = pending if isinstance(pending, list) else pending.get("requests", [])
        mine = [r for r in items if agent_id in json.dumps(r)]
        if mine:
            request_id = mine[0]["id"]
        else:
            time.sleep(0.5)
    if request_id is None:
        claim.kill()
        raise RuntimeError(f"{agent_id}: no claim request appeared within {timeout_s:.0f}s")
    host.run("requests", "decide", request_id, "--approve", "--once")
    out, _ = claim.communicate(timeout=timeout_s)
    if claim.returncode != 0 or not (cwd / ".musterd" / "binding.json").exists():
        raise RuntimeError(f"{agent_id}: claim did not bind the folder ({claim.returncode}): {out[-400:]}")
