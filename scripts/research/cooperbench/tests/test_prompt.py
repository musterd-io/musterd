"""The arms get the same amount of coaching: the musterd block has the coop block's shape."""

from __future__ import annotations

import re

from cooperbench.agents._coop.prompt import _coop_block
from cooperbench.agents._coop.prompt import build_instruction as coop_instruction

from musterd_cooperbench.prompt import build_instruction, musterd_block


def _shape(block: str) -> tuple[int, int]:
    """(numbered workflow steps, fenced blocks)."""
    return len(re.findall(r"^\d+\. ", block, re.M)), block.count("```") // 2


def test_block_mirrors_the_coop_block():
    ours, theirs = musterd_block("agent1", ["agent2"]), _coop_block("agent1", ["agent2"])
    assert _shape(ours) == _shape(theirs)
    assert ours.splitlines()[0] == theirs.splitlines()[0]
    assert ours.rstrip().splitlines()[-1] == theirs.rstrip().splitlines()[-1]
    assert "coop-" not in ours


def test_instruction_swaps_only_the_coop_block():
    ours = build_instruction("TASK", agents=["agent1", "agent2"], agent_id="agent1", git_enabled=True)
    theirs = coop_instruction("TASK", agents=["agent1", "agent2"], agent_id="agent1", git_enabled=True)
    assert ours.replace(musterd_block("agent1", ["agent2"]), "X") == theirs.replace(
        _coop_block("agent1", ["agent2"]), "X"
    )


def test_no_scope_is_ever_given_to_the_agent():
    # Lanes are agent-declared (nick, 2026-10-19): the instruction names no file to edit.
    text = build_instruction("TASK", agents=["agent1", "agent2"], agent_id="agent1", git_enabled=False)
    assert ".py" not in text.replace("patch.txt", "")


def test_lean_block_keeps_the_shape_and_names_one_integrator():
    # Cost-fix manifest (finding 036): same coaching shape, no join call, one integrator.
    base, lean = musterd_block("agent1", ["agent2"]), musterd_block("agent1", ["agent2"], lean=True)
    assert _shape(lean) == _shape(base)
    assert "joins you to the team" in base and "joins you to the team" not in lean
    assert "One of you integrates" in lean and "One of you integrates" not in base
    assert lean.rstrip().splitlines()[-1] == base.rstrip().splitlines()[-1]
    # Only the lines the lean arm adds are held to 80 columns; the tool table above them is the
    # baseline's own, unchanged.
    added = [line for line in lean.splitlines() if line not in base.splitlines()]
    assert added and all(len(line) <= 80 for line in added)
