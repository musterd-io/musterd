"""The arm wires musterd as it ships: hook commands match claudeCode.ts word for word."""

from __future__ import annotations

import re
from pathlib import Path

from musterd_cooperbench import config as cfg

CLAUDE_CODE_TS = Path(__file__).resolve().parents[4] / "packages/cli/src/onboard/harnesses/claudeCode.ts"


def _ts_command(fn: str) -> str:
    """Rebuild a hook command from the `return ( … );` string literals of `function <fn>()`."""
    src = CLAUDE_CODE_TS.read_text()
    body = src[src.index(f"function {fn}(): string {{") :]
    expr = body[body.index("return (") : body.index(");")]
    literals = re.findall(r"'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`", expr)
    text = "".join(a or b for a, b in literals)
    return text.replace("${POSTTOOLUSE_HOOK_MARKER}", "musterd-interrupt-hook").replace(
        "${PRETOOLUSE_HOOK_MARKER}", "musterd-gate-hook"
    )


def test_gate_hook_matches_claude_code_ts():
    assert cfg.GATE_HOOK == _ts_command("preToolUseHookCommand")


def test_interrupt_hook_matches_claude_code_ts():
    assert cfg.INTERRUPT_HOOK == _ts_command("postToolUseHookCommand")


def test_settings_carry_only_the_two_hooks_and_cooperbench_env():
    s = cfg.claude_settings({"MAX_MCP_OUTPUT_TOKENS": "2000"})
    assert set(s["hooks"]) == {"PreToolUse", "PostToolUse"}
    assert s["hooks"]["PreToolUse"][0]["matcher"] == cfg.GATE_MATCHER
    assert s["env"] == {"MAX_MCP_OUTPUT_TOKENS": "2000"}
    assert "env" not in cfg.claude_settings()


def test_mcp_config_is_the_musterd_server_alone():
    m = cfg.mcp_config({"MUSTERD_TEAM": "t"}, command="node", args=["/x/index.js"])
    assert list(m["mcpServers"]) == ["musterd"]
    assert m["mcpServers"]["musterd"]["args"] == ["/x/index.js"]


def test_git_exclude_keeps_the_binding_out_of_the_patch():
    assert cfg.GIT_EXCLUDE.strip() == ".musterd/"
