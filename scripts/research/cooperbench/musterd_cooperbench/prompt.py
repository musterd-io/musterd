"""The musterd arm's instruction: CooperBench's own sections, with its coop block swapped for ours.

The block mirrors CooperBench's `_coop_block` (agents/_coop/prompt.py at 63b9d44) section for
section: who you are, what each agent was given, the tools, a four-step workflow and the same
closing line. The two arms then differ in the coordination layer, not in how much coaching the
agent gets. The task text, the submission protocol and the optional git block are CooperBench's,
reused as-is.
"""

from __future__ import annotations

from cooperbench.agents._coop.prompt import _SUBMISSION_BLOCK, _git_block


def musterd_block(agent_id: str, partners: list[str]) -> str:
    partner_str = ", ".join(partners)
    return f"""## Cooperation protocol

You are **{agent_id}**, working alongside: **{partner_str}**.
Each agent has been assigned a separate feature from the same codebase;
your features may overlap (touch the same files), so coordinate to avoid
clobbering each other's changes.

You are all seats on one musterd team. Use the `musterd` MCP tools to
coordinate:

```text
lane_open      open a lane: a title, the file globs you will edit (scope), claim: true
lane_board     see every lane, who owns it and what it covers
team_send      send an act to a teammate (to: <agent id>): message, ask, request_help, handoff
team_inbox_check  read what has been sent to you
```

Every edit is gated: you can only edit files inside a lane you have claimed.
An edit outside your lanes is refused, and the refusal says why.

Recommended workflow:

1. At the start, open and claim a lane whose scope names the files you
   intend to touch, then `team_send` your partners a short summary of your
   feature and your lane.
2. Check `team_inbox_check` at minimum after major edits and before
   submitting. Acts addressed to you also appear after your tool calls.
3. If two agents need to modify the same file, coordinate explicitly
   (split the file, agree on one owner and hand off, or ask the owner to
   make the change).
4. Keep messages short and focused: file names, function names, and
   one-sentence intents are usually enough.

Messages are not magic — your peers only know what you tell them.
"""


def build_instruction(task: str, *, agents: list[str], agent_id: str, git_enabled: bool) -> str:
    """CooperBench's coop instruction with the musterd block in the coop block's place."""
    partners = [a for a in agents if a != agent_id]
    sections = [task, _SUBMISSION_BLOCK, musterd_block(agent_id, partners)]
    if git_enabled:
        sections.append(_git_block(agent_id, partners))
    return "\n\n---\n\n".join(sections)
