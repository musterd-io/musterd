# 487 — Nothing vanishes: a plan's increments are lanes under its Goal, and closing a lane asks what is left

- Status: accepted
- Date: 2026-09-30
- Deciders: nick (directed and approved the design), dolly (lane `01M3T8MJK8H4M86DZJEBMW6KM8`)
- Spec: `docs/superpowers/specs/2026-09-30-nothing-vanishes-design.md`
- Amends: [ADR 373](373-a-recorded-intention-names-its-lane.md) (retires repo-sourced Seeds and
  `intents:ingest`; widens `intents:check`)
- Relates to: ADR 258 (goal status is derived; shipped = every lane terminal), ADR 466 (the `parked`
  state), ADR 445/474 (traces record tool names, not to-do text)

## Context

A multi-increment plan is written in a spec or ADR, increment 1 gets a lane, the lane closes, and
the later increments are dropped — neither built nor tracked. nick named it on 2026-09-21 and again on
2026-09-30. A four-slice audit on 2026-09-30 (ADRs; specs, plans and design docs; harness
transcripts; lanes, goals, Seeds, PRs and git) found about twenty such items, listed in the spec's
Appendix A.

Follows-up: 01M3T8MJK8H4M86DZJEBMW6KM8

Two earlier fixes did not hold. ADR 373 (2026-09-03) gates forward references by phrase regex over
three surfaces, and most plans live elsewhere or in phrasings it misses; its Seed ingest last ran
2026-09-04. The 2026-09-21 practice of opening every increment's lane up front worked for
`seat-continuity` but never reached guidance.

## Problem

1. The plan lives in a document and the board sees only the increment being built, so a Goal
   derives `shipped` once that lane closes.
2. Nothing fires when increment 1's lane closes; `depends_on` points only backward.
3. Detection by phrase is lossy by construction.
4. A Seed counts as settled once promoted, even when only increment 1 shipped.

## Decision

The outcome is that **nothing silently vanishes**: every declared increment, named follow-up and
unfinished session to-do has a visible disposition — built, parked with a trigger, or dropped with
a reason. Dropping is allowed on a seat's own authority; forgetting is not. No new terms.

1. **A plan with more than one increment is a Goal; each increment or follow-up is a Lane under
   it, opened when the plan is made.** To build: `open`, chained by `depends_on`. Deferred:
   `parked` with `park_until`/`park_reason`. Dropped: `abandoned` with `abandon_reason`. Because
   `parked` is non-terminal, a Goal cannot derive `shipped` while any increment is unbuilt.
2. **`follows_up` on `lane_submit` and `lane_resolve`** — `"none"` or a list of lane ids. Optional
   by default (absent records `none`). The close is **refused until it is answered** when a
   leftover-work signal is present: the lane carries an unfinished to-do snapshot, or its title or
   detail declares a part (`N of M`, `N/M`, `increment N`, `phase N`, an id like `1A`). Named lanes
   with no goal attach to the closing lane's goal; if neither has one, the close is refused with
   the repair. The acceptance ask shows the answer.
3. **`abandon_reason`** (≤ 280 chars) on `lane_update`, mirroring `park_reason`; required on an
   abandoned lane named in `follows_up`.
4. **Session to-dos become a snapshot on the lane, never a Seed.** Each harness's `Stop` hook reads
   the unfinished to-dos from its own transcript (Claude Code `TodoWrite` and Task tools, Codex
   `update_plan`, Cursor `Todo`) and writes them as `unfinished_todos` on the seat's most recently
   updated active lane, last write wins. With no lane they go to seat memory.
5. **`intents:check` becomes structural.** It also scans `docs/superpowers/specs`,
   `docs/superpowers/plans` and `docs/design`; in any section headed Increments or Phases, every
   row cites a lane id, `parked <lane id>`, or `dropped — <reason>`. Existing docs start in a
   burn-down baseline. The phrase check stays for loose sentences.
6. **Repo-sourced Seeds retire.** `intents:ingest` is removed and the open `repo` Seeds are triaged
   into lanes or dropped with a reason. The Seed tray is for a human's ideas and Slack.
7. **Guidance, a stale-goal line, and a weekly sweep.** Guidance says: *more than one increment?
   Declare a Goal and open every increment's lane now.* `team_next` shows an in-flight goal whose
   open lanes have not changed state in 7 days. The `sweep` service reruns the audit's cheap checks
   weekly and posts one `status_update` only when it finds something.
8. **`FEATURE_EPOCH` 26 → 27.** All fields additive.

The five lanes under goal `nothing-vanishes` carry the build; the spec's §7 maps them.

## Alternatives rejected

- **A new first-class plan object** holding ordered items. Cleaner on paper, but it duplicates what
  `open`, `parked` and `abandoned` lanes already represent — two homes for one fact — and adds a term.
- **Detect and sweep only** (ADR 373 widened). No blocking at the moment of loss, which is the one
  place the last two fixes did not reach.
- **A mandatory `follows_up` on every close.** Most lanes are one-shot; an answer required every time
  becomes a rubber stamp.
- **Session to-dos as Seeds.** Seeds are a human's ideas; to-dos churn all session and are mostly
  sub-steps of the lane in progress.
- **Reading to-dos from the trace.** Traces carry tool names; to-do text is content, captured only
  under consent.

## Consequences

- Goal status becomes honest without changing its derivation: a plan that is fully on the board
  cannot read `shipped` early.
- A closer on a signalled lane pays one field. Everyone else pays nothing.
- To-do titles reach the team's daemon, which only lane titles did before. They are the seat's own
  notes about team work, shown to the team and the acceptor.
- A plan that lives only in an agent's head — no to-do, no doc, no part marker — is not caught
  structurally. The stale-goal line and the weekly sweep are its backstop.
- ADR 373 increment 3 (code-comment scan, ADR-status flag) is superseded by this decision, not built.
- **2026-09-30 — parking stays human-only.** Found on the first use of Decision 1: the daemon refuses
  a park from an agent ("parked means a person chose 'not now'", ADR 466). So a seat cannot defer by
  itself. A seat that wants to defer opens the lane, writes the trigger in its detail, and asks a
  human to park it; until then the lane stays `open`, which is still a visible disposition.
  `follows_up` (lane 3) accepts an open lane for exactly this reason. Dropping (`abandoned`) stays
  self-serve. The triage in lane 1 followed this: nick chose the parks, and he runs them.
- **2026-09-30 — the structural rule landed (lane 2, `01M3T8MQ6ZJQPC2MXD3RCK5YX9`).** Measured at
  merge: 163 rows and items in Increments/Phases sections, 12 citing a lane or a drop, 151 on the
  burn-down (`scripts/intents-increments-baseline.ts`). Decision 5's wider surfaces apply to the
  structural rule only; the phrase check keeps ADR 373's three, because the open ADR 373 watch voids
  if they move inside its window. `intents:ingest` is gone; the 32 `repo` Seeds were closed against
  spec Appendix B.
- **2026-09-30 — the close question landed (lane 3, `01M3T8MW01JB0JV0MKNB7WVWFZ`).** S2 only: S1 (an
  unfinished to-do snapshot) joins `leftoverSignal` with `unfinished_todos` in lane 4. Two readings
  the Decision left open, stated here: the question is asked of the lane's own closer (its owner, or
  anyone closing an unowned lane), never of an acceptor; and an absent answer is stored as null,
  which reads as none. The MCP field is one undescribed string (`"none"` or comma-separated ids) to
  hold the tools-list budget at +88 B; the refusal names the shape when it fires.
- **2026-09-30 — the to-do snapshot landed smaller than Decision 4 (lane 4,
  `01M3T8N0ZBKPBWDYWEEDNH30ED`).** Measured before building: zero to-do tool calls in 14 days —
  673 Claude Code transcripts (`TodoWrite`, `TaskCreate`, `TaskUpdate`) and 61 Codex sessions
  (`update_plan`). nick chose to build it as cheap insurance for other teams, with three cuts: (1)
  Claude Code and Codex only — Cursor registers no stop hook and keeps no transcript a hook can open;
  (2) no new hook — it rides the turn-boundary reads the trace tail already makes (Claude `Stop`,
  Codex per-call), and calls the daemon only when the unfinished list changed; (3) no seat-memory
  fallback — seat memory is one hand-written note, last write wins, and a turn-end hook would
  overwrite it every turn. A seat with no live lane gets no snapshot. S1 now feeds `leftoverSignal`.
- **2026-09-30 — guidance, the stale-goal line and the audit landed (lane 5,
  `01M3T8N2ZP55HNR99GKDD69RKE`).** The guidance line is in `guidance.ts` (the musterd skill).
  `team_next` carries `stale_goals`. The weekly audit is `pnpm goals:audit` (`scripts/goals-audit.ts`):
  the sweep LaunchAgent runs it `--weekly --post` from the daemon's checkout, where the docs live,
  and it posts as the `sweep` service seat only when it finds something. nick chose this home over
  derived `team_next` lines and a daemon timer. It adds one passenger to the ADR 166 slot sweep,
  whose header promised to touch no daemon; the slot sweep itself stays read-only, and the header now
  says what rides along. Check 2 counts only lanes closed after #1897 merged (2026-10-01T00:42Z),
  the moment the close question began to exist. Its first hand-run found two items, both real: lane 2
  closed before the field existed, and lane 3's own answer was dropped by a daemon not yet
  refreshed. The cutoff fixed the first; lane 3's answer was re-recorded.
- **2026-09-30 — the trigger rule moved to the primer (lane `01M3TW8NNN6YBQQFY34PGCFMED`).** Lane 5
  put "more than one increment? declare a Goal" in the skill only. ADR 085 says the skill holds
  on-demand playbooks and the primer holds the loop kernel; a rule whose moment (writing a plan)
  carries no cue to open the skill is kernel, so a skill-only copy never fires. The primer's lane
  bullet now carries it (+57 B, within the 35-line cap); the skill keeps only the mechanics
  (`follows_up`, `abandon_reason`, parking), so the rule lives in one layer.

- _(2026-10-13, lane 01M4VY3DQ2.)_ **The `N of M` signal read counts as parts.** Across all 1,988 lanes on
  the live store, the §5.1 pattern matched 73 times in a title or detail; 57 of those were counts in
  evidence ("8 of 11 seat worktrees", "20 of 20 acceptors"), and some were not even the numbers
  written: `\b` falls inside a grouped number, so "1,127 of 1,232" read as "127 of 1" and
  "9,393 of 22,496" as "393 of 22". Two of izzo's closes were refused on 2026-10-13. `N of M` now signals
  only outside a grouped number and when nothing follows it but punctuation, the end, or a part noun
  (part, increment, phase, step, lane): 16 matches remain and no plan part was lost. The other signals
  are unchanged, and a false positive still costs one `follows_up: "none"`.

- _(2026-10-26, lane 01M5GEMZ07.)_ **The `N/M` signal read scores as parts.** On 2026-10-21 two
  closes were refused: lane `01M5GCF88Z` ("… pilot 3's musterd 4/10 can be read …", a pass rate) and
  lane `01M5G6AGDY` ("pilot-musterd 20/20 agents", a count). `N/M` now takes the `N of M` rule:
  it signals only when nothing follows it but punctuation, the end, or a part noun (part, increment,
  phase, step, lane). "OpenCode 2/4 — setup", "(2/3)", "2/4: the gate" and "3/5 lanes" still
  signal. The store was not re-counted for this change; the cases come from the two refusals and
  the board's own plan titles. The other signals are unchanged.

## Observability & Evaluation

**Traces.** No new trace. The reads are the lane store (`follows_up`, `abandon_reason`,
`unfinished_todos`, state history) and the goal derivation.

**Eval.** Dataset: plans, named follow-ups and unfinished to-dos created after lane 3
(`01M3T8MW01JB0JV0MKNB7WVWFZ`) lands. Baseline (2026-09-30): about twenty untracked items across
ADRs, specs, plans and design docs (spec Appendix A). Falsifier: on 2026-11-01 a rerun of the
four-slice audit finds any item in that population with no lane or disposition. The watch is
`docs/watches/2026-09-30-nothing-vanishes.md`.

**Experiment.** n/a — the close check and the docs gate are deterministic and covered by unit tests
(each signal refuses; no signal passes; goal attach and refusal; baseline burn-down). The eval reads
the outcome in production.
