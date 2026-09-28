# 467 — A Claude Code Desktop seat labels its own session: `set_session_title` with `session_id: "self"`

- Status: accepted — 2026-09-28 (renumbered from 465 the same day: PR #1791 had published 465 sixty seconds earlier)
- Date: 2026-09-28
- Lane: `01M3MSPAMA7K3XW2XWHGHTEJXX` (goal `seat-continuity`)
- Amends: [ADR 418](418-session-label-capability-is-the-tool-list.md) (the tool-list branches),
  [ADR 442](442-the-wall-seats-reach-no-session-outside-the-seat-set.md) (its Consequences note on
  labeling). Reverses neither.

## Context

ADR 418 made the orient skill choose a labeling branch from this session's tool list: peer sweep
(`list_sessions` + `set_session_title`), else `rename_chat` self-label, else skip. ADR 442 retired
the peer sweep because it reached every session on the machine, and #1676 removed it from the
guidance (content version 30). The orient skill then read: `rename_chat` → self-label, else skip,
"the host labels seat sessions (ADR 166)".

ADR 166 is session liveness by enumeration. It labels nothing. No host process labels a Claude Code
Desktop sidebar row: the app's session title is written only by the app itself or by a session's
`mcp__ccd_session_mgmt__set_session_title` call. So from 2026-09-24 a Desktop seat oriented, saw no
`rename_chat`, skipped silently as instructed, and its sidebar row stayed whatever the app
auto-generated. Diagnosed 2026-09-28 in the dolly seat.

`set_session_title` takes `session_id`, and the app documents the literal `"self"` as this session.
The tool is not in `SESSION_REACH_TOOLS` (ADR 442 item 2; `enforcement.test.ts` pins it as allowed),
because renaming is not reach. The wall retired the *sweep*, which discovered other sessions through
`list_sessions`; a call that names only `"self"` discovers nothing and touches nothing outside the
seat. It is the Desktop equivalent of Cursor's `rename_chat`, which ADR 442 kept for exactly that
reason.

## Problem

The orient skill had no Desktop branch, and the reason it gave for skipping was false. Desktop
seats went unlabeled while the skill said the host had it covered.

## Decision

1. Orient step 6 gains a first branch: `set_session_title` in the tool list → self-label THIS
   session with `session_id: "self"` and the shared grammar (`🔶 Dolly (Fri 3p) - <subject>`).
   `"self"` is the only `session_id` a seat may pass; an id from any other source is reach and is
   refused by the wall's rule, not merely discouraged. Then `rename_chat` → the same on Cursor. Else
   skip silently, as before.
2. The self-label skill (`renderSelfLabelSessionSkill`) names both tools. It is still provisioned
   only where a rule catalog gates on description (Cursor `.cursor/rules/musterd-label-session.mdc`);
   Claude Code carries the same instruction inside the orient skill it already has, so no new file
   is written for it.
3. The "host labels seat sessions (ADR 166)" sentence leaves the guidance. Where the skill states a
   reason for a skip, the reason has to be true.

## Consequences

- Guidance content version 32 → 33. Seat Workspaces refresh at their next guidance write.
- A Desktop seat labels its own row on orient. A title the user typed wins (the app asks the user
  before replacing one they set; a seat never argues with that prompt).
- ADR 442's per-harness reach table is unchanged. This ADR adds no tool to `SESSION_REACH_TOOLS`
  and removes none; a future finding that `set_session_title` accepts a foreign id *without*
  `list_sessions` having been called is still not reach — the seat has no id to pass.
- The rest of ADR 418 (stamp always follows; `label-nudge` silent on known no-write drivers; no
  per-driver orient files) stands.

## Observability & Evaluation

- **Traces.** None added. The rename is the app's own; the orient stamp is unchanged.
- **Eval.** Unit: `renderOrientSkill` names `set_session_title` with `session_id: "self"` and
  "never any other session_id", still names `rename_chat`, still "skip silently", still ends on
  `musterd session orient-stamp`; the self-label skill's skip clause names both tools; the wall
  test still finds no `list_sessions` / `ListAgents` in any rendered guidance. Baseline: content
  version 32's orient skill has no Desktop branch.
- **Experiment.** Falsifier: a Desktop seat session, freshly provisioned at version 33, that ends
  orient with an app-generated title. Check the sidebar after the next few dolly/ryder Desktop
  starts.
