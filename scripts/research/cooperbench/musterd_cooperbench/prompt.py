"""The musterd arms' instructions: CooperBench's own sections, with its coordination block swapped for ours.

The block mirrors CooperBench's `_coop_block` (agents/_coop/prompt.py at 63b9d44) section for
section: who you are, what each agent was given, the tools, a four-step workflow and the same
closing line. The two arms then differ in the coordination layer, not in how much coaching the
agent gets. The task text, the submission protocol and the optional git block are CooperBench's,
reused as-is.
"""

from __future__ import annotations

from cooperbench.agents._coop.prompt import _SUBMISSION_BLOCK, _git_block


# The two waiting sentences the arm added (finding 019 fix B). On the act lane (rider 7) they are
# replaced by the product's own guidance: end the turn, the host resumes the seat on the next act.
_WAIT_LAUNCH = """   When you must wait for a partner, wait in ONE call —
   `team_inbox_check` with `wait: 45` blocks until a directed act arrives
   (repeat it if it times out). Never poll with repeated checks or `sleep`."""
_WAIT_ACT = """   When you must wait for a partner, end your turn: the host resumes
   you on the next directed act, and the wake carries it. Never poll with
   repeated checks or `sleep`."""
_HELD_LAUNCH = """the file, wait on that lane in one call (`team_inbox_check` with
   `wait: 45, until_lane: <holder lane id>`) — do not message for an ETA."""
_HELD_ACT = """the file, end your turn — the host resumes you when the lane frees the
   file, and the act says so — do not message for an ETA."""

# Rider 8 (finding 033): the act-lane sentence above was buried under a workflow that says "check"
# before each step, and the seats still waited inside their first calls (46 wait-mode checks and 22
# shell sleeps over ten pairs). The rule now leads the protocol, in its own block, and the workflow's
# "check" steps say "end your turn" where they said "check".
_TURN_RULE_ACT = """**Your turn is short.** The host wakes you whenever your partner sends you an
act, and the wake carries it and your work so far. The moment you are waiting on
your partner for anything — a reply, a lane to free, a file, a merge — END YOUR
TURN: write one line saying what you are waiting for, and stop. Do not call
`team_inbox_check` with `wait`, do not `sleep`, do not re-read the board while
you wait. Ending your turn costs nothing; waiting inside it is what costs.

"""
_CHECK_LAUNCH = """2. Check `team_inbox_check` at minimum after major edits and before
   submitting. Acts addressed to you also appear after your tool calls."""
_CHECK_ACT = """2. Check `team_inbox_check` once after major edits and once before
   submitting. Acts addressed to you also appear after your tool calls. If it
   is empty and you cannot proceed without your partner, end your turn."""


# The lean arm (cost-fix manifest, finding 036). Step 1 no longer spends a call joining: since ADR
# 707 the MCP server joins at session start. And one agent integrates: in the flash run both agents
# fetched, merged and pushed in every pair. The second to finish merges the first's pushed branch, so
# both patches carry the first agent's hunks unchanged and CooperBench's merge of the two is clean.
_FIRST_LAUNCH = """1. Your first action is `team_inbox_check`, which joins you to the team.
   Then open and claim a lane"""
_FIRST_LEAN = """1. You joined the team when your session started. Open and claim a
   lane"""
_INTEGRATE_LEAN = """
**One of you integrates.** When your feature is done, push your branch,
resolve your lane and tell your partners you are done. If a partner told you
they were done before you finished, you are the integrator: fetch their
pushed branch, merge it into yours without changing their lines unless a
conflict forces it, run the tests and push. If you finish first, do not merge
— send your done message and stop.
"""


def musterd_block(agent_id: str, partners: list[str], *, lane: str = "launch", lean: bool = False) -> str:
    partner_str = ", ".join(partners)
    wait = _WAIT_ACT if lane == "act" else _WAIT_LAUNCH
    held = _HELD_ACT if lane == "act" else _HELD_LAUNCH
    turn_rule = _TURN_RULE_ACT if lane == "act" else ""
    check = _CHECK_ACT if lane == "act" else _CHECK_LAUNCH
    first = _FIRST_LEAN if lean else _FIRST_LAUNCH
    integrate = _INTEGRATE_LEAN if lean else ""
    return f"""## Cooperation protocol

You are **{agent_id}**, working alongside: **{partner_str}**.
Each agent has been assigned a separate feature from the same codebase;
your features may overlap (touch the same files), so coordinate to avoid
clobbering each other's changes.

{turn_rule}You are all seats on one musterd team. Use the `musterd` MCP tools to
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

{first} whose scope names the files you intend to
   touch, and `team_send` your partners a short summary of your feature
   and your lane.
{check}
{wait}
3. If two agents need to modify the same file, coordinate explicitly
   (split the file, agree on one owner and hand off, or ask the owner to
   make the change). If an edit is refused because a partner's lane holds
   {held}
4. Keep messages short and focused: file names, function names, and
   one-sentence intents are usually enough.
{integrate}
Messages are not magic — your peers only know what you tell them.
"""


def musterd_system_section(agent_id: str, teammates: list[str], git_enabled: bool) -> str:
    """The OpenHands arm's collaboration section, in the system prompt slot the plain arm's goes in.

    Mirrors ``get_coop_system_prompt`` (openhands-tools preset/default.py at 63b9d44) section for
    section: the opening line, a Scenario, a four-step Required workflow, the same closing warning,
    and the same Git block. Only the coordination layer changes: `send_message` becomes `team_send`,
    the first step also opens a lane, and the gate is described as it is — file-editor edits only.
    """
    all_agents = [agent_id, *teammates]
    agents_str = ", ".join(all_agents)
    teammate_name = teammates[0] if teammates else "teammate"
    section = f"""You are {agent_id} working as a team with: {agents_str}.

<collaboration>

## Scenario
Your teammate ({teammate_name}) is implementing the other feature in this same codebase right now. You are both editing files in parallel but you cannot see each other's changes. When you're done, your work will be merged — if any of your edits touch the same lines, both patches are thrown away.

You are both seats on one musterd team. Coordinate with the musterd tools: `team_inbox_check` (read what was sent to you), `team_send` (send an act to a teammate: message, ask, request_help, handoff), `lane_open` (open a lane: a title, the file globs you will edit as its scope, claim: true) and `lane_board` (every lane, who owns it, what it covers). Edits through the file editor are gated: you can only edit files inside a lane you have claimed, and a refused edit says why.

## Required workflow

1. Your first action is `team_inbox_check`, which joins you to the team. Then explore the codebase to understand what files you need to change, open and claim a lane whose scope names every file you plan to modify, and tell {teammate_name}:
   team_send(to="{teammate_name}", act="message", body="I plan to modify: <list files and functions>. My lane: <lane>")

2. Wait for a reply from {teammate_name}. Acts addressed to you will appear automatically in your conversation as ⚡ musterd ... — check for overlaps and coordinate if needed.

3. While you are working, if you discover you need to change files you didn't mention, message {teammate_name} and widen your lane before editing them.

4. When you are done, send a final summary of every file you changed:
   team_send(to="{teammate_name}", act="message", body="Done. I changed: <list files and changes>")

Do not skip these steps. If your edits conflict with your teammate's, both of your patches will be discarded.
"""
    if git_enabled:
        section += f"""
## Git
A shared remote called `team` is configured. Your branch is `{agent_id}`.
Teammates' branches are at `team/<name>` (e.g., `team/{teammate_name}`).
* Push: `git push team {agent_id}`
* Fetch: `git fetch team`
"""
    section += """
</collaboration>
"""
    return section


def build_instruction(
    task: str, *, agents: list[str], agent_id: str, git_enabled: bool, lane: str = "launch", lean: bool = False
) -> str:
    """CooperBench's coop instruction with the musterd block in the coop block's place."""
    partners = [a for a in agents if a != agent_id]
    sections = [task, _SUBMISSION_BLOCK, musterd_block(agent_id, partners, lane=lane, lean=lean)]
    if git_enabled:
        sections.append(_git_block(agent_id, partners))
    return "\n\n---\n\n".join(sections)
