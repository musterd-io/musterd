# 468 — A seat session is titled `seat · start time · team · title`, and the dead label sweep leaves the code

- Status: accepted — 2026-09-28
- Date: 2026-09-28
- Lane: `01M3MWSF32Q6CJ5MR425NJ9PHQ` (goal `seat-continuity`)
- Supersedes: the sidebar grammar of [ADR 160](160-seat-session-labels.md) (`🔶 Seat (Fri 3p) - subject`),
  as carried forward by [ADR 186](186-cross-harness-session-labels.md) and
  [ADR 467](467-desktop-seat-self-label-own-session.md). Completes the retirement
  [ADR 442](442-the-wall-seats-reach-no-session-outside-the-seat-set.md) began: the sweep's
  engine, its nudge rail, and its machine-wide stamp are removed, not just unreferenced.
- Amends: [ADR 418](418-session-label-capability-is-the-tool-list.md) (the `label-nudge` driver
  silence no longer exists — there is nothing to silence), [ADR 212](212-standing-context-budget.md)
  (`labelNudgeBytes` leaves the budget).

## Context

ADR 160 gave seat sessions a sidebar label, `🔶 Miley (Fri 3p) - Daemon refresh`, written by a
machine-wide *sweep*: a Claude Code session listed every session on the machine and renamed the
ones it could attribute to a seat. ADR 442 (the wall, 2026-09-24) retired that sweep as reach —
a seat may touch no session outside itself — and ADR 467 (2026-09-28) gave Claude Code Desktop
the self-label path Cursor already had: the orient skill titles **this** session, and nothing else.

Two things were left behind. First, the sweep's code: `resolveLabels` and its CCD-record scanner,
the evidence-based `labelSweepDue`, the `~/.musterd/label-sweep.json` stamp, `LABEL_NUDGE_TEXT` and
its context-budget line item, and a `musterd session label-nudge` clause in both machine-wide hooks
that called a subcommand ADR 442 had already turned into a no-op. Roughly 400 lines and 40 tests
exercising a path no seat runs. Second, the grammar: designed for a sweep, it led with the chip
so a sweep could tell its own work from a human's, capitalized the seat because the sweep wrote
prose, and carried no team because the sweep ran per machine. Read by a human on a sidebar that
now lists *only* seat-labeled rows, the chip in front of every one says nothing, and the team —
the one field that distinguishes two seats of the same name on one machine — is missing.

Measured today (lane 01M3MSPAMA, dolly): the orient skill said "the shared grammar" without
spelling it out, and a seat labeled itself `dolly · revive · idle` from memory. The grammar has
to be in the skill text, and it has to be one a reader can reconstruct.

## Problem

The sweep is retired but its code, hook clause, budget item, and stamp file are all still on the
machine; and the self-label grammar is the sweep's, not the reader's.

## Decision

1. **The sidebar grammar is `<seat> · <start time> · <team> · <title>`.** Lowercase seat (the
   CLI's own voice: roster, statusline, terminal tab). Start time as `Mon 1p` / `Jul 11 3p`
   (`formatLabelWhen`, unchanged). Team. Then the host's own auto-summarized title, verbatim. The
   divider is a spaced middle dot. No chip: `SEAT_CHIP` stays the terminal-tab and statusline mark.
   `renderSessionLabel` in `@musterd/protocol` is the grammar's one executable definition;
   `stripSessionLabel` recovers the host's words behind an existing stem (this grammar or the old
   one) so a re-orient is idempotent — never two stems, never a re-date.
2. **The self-label skill and orient step 6 spell the grammar out**, with an example. The skill
   is the only writer: Claude Code Desktop `set_session_title {session_id: "self"}` (ADR 467),
   Cursor `rename_chat`. Guidance content version 34 → 35.
3. **The sweep's code is deleted.** `resolveLabels`, `scanCcd`, `lookupCcdMeta`, `ccdSessionRows`,
   `labelSweepDue`, `stampLabelSweep`, `LABEL_SWEEP_STALE_MS`, `LABEL_NUDGE_TEXT`,
   `TERMINAL_TERM_PROGRAMS`, `labelNudgeHasNoSidebarWrite`, the `session resolve-labels`
   subcommand, and `parseSeatLabel` / `renderSeatLabel` / `capitalizeSeat` in the protocol, with
   their tests. `~/.musterd/label-sweep.json` is no longer read or written (an existing file is
   inert; nothing removes it).
4. **The hooks drop the `label-nudge` clause.** Both machine-wide hooks (SessionStart,
   UserPromptSubmit) run only `orient-nudge` now. `FEATURE_EPOCH` 25 → 26 so an older checkout's
   `init` cannot write the clause back (ADR 168). `musterd session label-nudge` stays a silent
   no-op subcommand for hooks written before this epoch.
5. **`labelNudgeBytes` leaves the standing-context budget** (`docs/perf/context-budgets.json`,
   `check-budgets.ts`, the coherence test). The per-turn and per-session composites lose that
   part and their ceilings drop by exactly its 103 B (18487 → 18384, 21833 → 21730): the
   coherence test keeps the per-turn ceiling binding — parts exactly spend it — so the ceiling
   moves with the part. No component budget changes.

## Consequences

- A seat that orients on guidance 35 titles its session `dolly · Mon 1p · revive · <title>`.
  Rows labeled under the old grammar keep it until that session next orients; the strip helper
  recognizes both forms, so the upgrade is one orient away and never stacks.
- The per-turn hook is one clause shorter on every seat machine after the next `init`
  / `init --refresh-hooks` (epoch 26). Older hooks still call `label-nudge` and get a silent 0.
- `HarnessGuidance.sessionsSkillPath` and the `RETIRED_GUIDANCE_PATHS` sweep of the old
  `musterd-label-sessions` skill file are untouched: they belong to the wall's provisioning
  sub-lane and still clean up pre-wall Workspaces.
- ADR 160's observability paragraph ("the stamp file's age is the trigger's health") describes a
  trigger that no longer exists; the standing check is now the sidebar itself, read directly.

## Observability & Evaluation

- **Traces.** None added. The rename is the app's own; nothing else changed at runtime.
- **Eval.** Unit: `renderSessionLabel` renders the four fields in order with the middle-dot
  divider and no chip; `stripSessionLabel` round-trips its own output and strips the old grammar
  (chipped, dated, bare); the rendered self-label skill and orient step 6 contain the literal
  `<seat> · <start time> · <team>`; the refreshed UserPromptSubmit hook does not contain
  `label-nudge`; the budget file is coherent without `labelNudgeBytes`. Baseline: version 34's
  skill says "the shared grammar" and never states it.
- **Experiment.** Falsifier: a Desktop or Cursor seat session, provisioned at version 35, whose
  title after orient does not start with `<seat> · `, or carries two stems. Check the sidebar
  after the next few seat starts on this machine.
