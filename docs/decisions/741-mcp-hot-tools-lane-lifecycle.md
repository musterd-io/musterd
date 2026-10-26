# 741 — MCP hot tools: the lane lifecycle, team_next and seat memory load up front

- Status: accepted
- Date: 2026-10-26
- Lane: 01M5X44XXE9BPECK7181TBAEEJ (goal `coordination-cost`)

## Context

Claude Code defers every MCP tool behind `ToolSearch` by default: the model sees a tool's name
only, and spends a turn fetching its schema the first time it needs it. Lane 01M4S53E79
(2026-10-13) marked four musterd tools `anthropic/alwaysLoad` — `team_join`, `team_inbox_check`,
`team_send`, `team_status` — because the doorbell eval showed a session's first musterd call paying
that extra turn first. The set was held at four for standing context (about 3 KB, ~750 tokens per
turn), and `hotTools.test.ts` pins it so it cannot grow by accident. The other 27 tools stayed
deferred; ADR 707 kept the key when the seat began joining at session start.

Finding 028 (CooperBench rider 6) listed `ToolSearch` beside the musterd calls: 58 calls, $1.11 of
an $18.45 run, about three per agent — the lane calls (`lane_open`, `lane_board`, `lane_resolve`)
the arm's instructions ask for, each loaded by a separate turn.

## Problem

The detour is cheap on the bench and expensive where seats actually work. Claude Code's own
transcripts on one revive machine, 2026-10-14 to 2026-10-26 (after lane 01M4S53E79 landed), read
with [`docs/research/hot-tools/toolsearch.py`](../research/hot-tools/toolsearch.py):

| | |
| --- | --- |
| sessions with a musterd `ToolSearch` | 48 of 69 |
| `ToolSearch` turns naming a musterd tool | 218, median 3.5 per session |
| the turn's own cost (list price) | median $0.30, mean $0.48, total $105 |
| context at the call | median 135k tokens |
| wall clock from the call to the next assistant turn | median 2.7 s, p75 5.3 s |

The turn is expensive because it fires mid-session at full context, and it buys nothing: the
schema it fetches sits in context from then on exactly as an always-loaded one would. Nine tools
account for 88% of the calls — `lane_submit` 53, `lane_claim` 49, `lane_board` 44,
`team_memory_save` 39, `lane_open` 38, `lane_update` 38, `team_next` 34, `team_memory_read` 28,
`lane_resolve` 13 — the lane lifecycle every seat runs, orientation, and seat memory. The rest
(`team_wake_context`, `lane_handoff`, the insight and goal tools, `team_members`) are each named in
five sessions or fewer.

Speed was the argument *for* loading up front, not against it: a cached block of schema costs
milliseconds of prefill per turn; the detour costs seconds, several times a session. The case for
deferral is tool-selection accuracy with hundreds of tools, which 13 of 31 does not approach.

## Decision

1. `HOT_TOOLS` grows from four to thirteen: the four above plus `team_next`, `lane_board`,
   `lane_open`, `lane_claim`, `lane_update`, `lane_submit`, `lane_resolve`, `team_memory_read`,
   `team_memory_save`. All thirteen carry `_meta: {"anthropic/alwaysLoad": true}` on their
   `tools/list` entries; nothing else does. The other 18 tools stay deferred.
2. The set is still pinned (`hotTools.test.ts`) and grows only on a measurement: a tool joins when
   the same read shows its `ToolSearch` turns cost more than its schema would standing in the turns
   before it is first used. Priced at cache-read rates against the baseline sessions, the nine added
   here remove $89.83 of turns and add $34.62 of standing schema — net $55 over twelve days on one
   machine, about $0.80 a session — and remove a median 2.7 s detour three to four times a session.
3. The standing-context budgets (`docs/perf/context-budgets.json`) rise by the key's wire bytes
   only: `toolsListDefaultBytes` 21725 → 22060 (+335 B, nine `_meta` entries), `toolsListMutedBytes`
   8499 → 8601 (the three read tools that stay on a muted seat), and the two composites with them,
   no headroom added. `_meta` is never shown to the model, so a harness without deferral holds the
   same schema text it did. What changes for Claude Code is which schemas stay in the prompt:
   12.4 KB (~3,100 tokens) instead of 3.0 KB.

## Consequences

- One list and its doc: `toolNames.ts`, the `hotTools.test.ts` comment (the pin derives from the
  list), `05-mcp.md` § hot tools, the CooperBench README note that cited four, and the four budget
  lines above with this ADR's falsifier as their rent. No protocol change, no new dependency,
  nothing a user configures; a server-level `"alwaysLoad": false` still
  overrides it, and other harnesses ignore the key.
- Every Claude Code seat carries ~2,350 more cached tokens per turn from its first turn. In a
  session that never touches a lane or memory — a read-only look at the board — that is pure cost,
  about $0.35 over a 100-turn Opus session. The baseline says such sessions are the minority (21 of 69
  had no musterd `ToolSearch` at all, and some of those made no musterd call).
- On CooperBench the arm's three `ToolSearch` calls per agent become about one (the arm names
  `team_inbox_check {wait}`, `lane_open`, `lane_board`, `lane_resolve`, and `lane_submit`, all hot
  now), worth under $0.70 of an $18 run. Not a reason on its own; the product reason above is.
- Dollar figures use Opus-class list prices; the ratios (turn cost to standing cost, detour seconds)
  are the load-bearing part.

## Observability & Evaluation

- **Traces:** `ToolSearch` is a harness tool, so the daemon never sees it; the record is Claude
  Code's transcript. `toolsearch.py` reads it locally and nothing leaves the machine.
- **Eval:** the week-after read. On or after 2026-11-03, run
  `python3 docs/research/hot-tools/toolsearch.py --since 2026-10-27` on the same machine and record
  in this section: calls per session (expect the median to fall from 3.5 toward 0–1), the detour
  distribution for what remains, and which tools are still named. Also confirm the hot thirteen
  are not among the named tools; if they are, the key is not being honoured by that session's
  Claude Code and the number says so.
- **Experiment:** none; the baseline is observational and the change is uniform. Falsifier: a
  week-after read where the median calls per session has not fallen, or a session cost comparison
  where per-turn cost rose by more than the schema tokens predict, puts the four-tool set back.
