# Nothing vanishes — design

- Date: 2026-09-30
- Author: dolly (lane `01M3T8MJK8H4M86DZJEBMW6KM8`), brainstormed with nick
- Goal: `nothing-vanishes`
- Status: accepted as ADR 487 (2026-09-30)
- Amends: [ADR 373](../../decisions/373-a-recorded-intention-names-its-lane.md) (retires repo-sourced Seeds)

## 1. The problem, in nick's words and in the record

> "for a new idea, musterd agents will come up with a grand plan that includes multiple
> increments/phases, open and implement a first increment, get sidetracked with something else and
> all the remaining increments of the original plan are lost." — nick, 2026-09-30

This is the third time the team has worked on it:

| When | Fix | What happened |
| --- | --- | --- |
| 2026-09-03 | ADR 373: a `Follows-up:` marker per forward reference, `pnpm intents:check`, repo-sourced Seeds, open Seeds on `team_next` | Live, but it scans only `docs/decisions`, `docs/wiki` and the roadmap, by phrase regex. Most plans live in specs, plans and design docs, in phrasings the regex misses ("Increment 1 of 3", "recorded, not closed", "pre-registered future increments"). Seed ingest is manual and last ran 2026-09-04. Its own increment 3 was lost. |
| 2026-09-21 | stanley, on nick's same complaint: open every increment's lane up front, chained by `depends_on`, under one goal, plus a watch (revisit 2026-10-19) | Worked for `seat-continuity`. Never written into guidance, so no other plan did it. |
| 2026-09-21 | The watch's fallback: "a goal whose lanes stay open past a dated horizon should surface on `team_next` as overdue" | Never built. |

The 2026-09-30 audit (four read-only slices: ADRs; specs/plans/design; harness transcripts; lanes,
goals, seeds, PRs and git) found about twenty items planned and never built or tracked. They are
listed in Appendix A so this finding cannot itself be lost.

## 2. Root causes

1. **The plan lives in a document; the board sees only the increment being built.** A Goal's
   status is derived from its lanes (`shipped` = every lane terminal, at least one `done`; ADR 258).
   The later increments never became lanes under it, so the goal reads `shipped` after increment
   1. `board-loops`, `research-radar` and `reach-and-boundaries` all read shipped with work still
   named in their docs.
2. **Nothing fires at the moment of loss** — when increment 1's lane closes. `depends_on` points
   backward only; there is no forward pointer, and closing a lane asks nothing about what is left.
3. **Detection is phrase-matching over three surfaces.** It is lossy by construction, and ADRs 373
   and 476 both say a green run is not an inventory.
4. **Seeds stop at "promoted"**, even when the lane they became delivered only increment 1 (the
   paved-road seed).
5. **nick is the scheduler.** Seats advance to increment N when nick types "start increment N".

## 3. What "fixed" means

Agreed with nick:

- **Outcome:** nothing silently vanishes. Every declared increment, named follow-up and unfinished
  session to-do has a visible disposition — built, parked with a trigger, or dropped with a reason.
  Dropping is fine; forgetting is not. The board tells the truth.
- **Scope:** declared increments and phases, named follow-ups, and agent-session plans/to-dos.
- **Enforcement is tiered by source:** declared work blocks at the moment of loss; session to-dos
  are captured and shown, because a session ending cannot meaningfully be blocked.
- **A seat may drop work on its own authority**, visibly: the reason is recorded and shown to the
  acceptor. No extra approval step.
- **No new terms.** Goal, Lane, Seed and `Follows-up` already exist; this design uses only them.
- **Seeds are nick's.** The Seed tray is for a human's ideas (and Slack), as originally intended.

## 4. The model

**A plan with more than one increment is a Goal, and each increment or follow-up is a Lane under
it, opened when the plan is made.**

| Disposition | Board state | Already exists? |
| --- | --- | --- |
| To build | `open` lane, chained by `depends_on` | yes |
| Deferred | `parked` lane with `park_until` / `park_reason` (ADR 466) | yes |
| Dropped | `abandoned` lane with a reason | state yes; the reason field is new (§5.1) |

Consequences, all from existing rules:

- A goal cannot read `shipped` while any of its increments is open or parked, because `parked` is
  not in `LANE_TERMINAL_STATES` (`packages/protocol/src/lanes.ts`). No goal-status change is needed.
- A goal is only the container. A goal with one lane is fine, and single-shot work needs no goal —
  as today.

## 5. What changes

### 5.1 Closing a lane asks what is left — only when something points to leftover work

`lane_submit` and `lane_resolve` (MCP and CLI) gain an optional `follows_up`: either `"none"` or a
list of lane ids.

- **No signal:** the field is optional. Absent is recorded as `none` and the close proceeds as today.
  Most lanes are one-shot work; a mandatory answer would become a rubber stamp.
- **A signal:** the close is refused until `follows_up` is answered. The signals:
  - **S1** — the lane carries an unfinished to-do snapshot (§5.2).
  - **S2** — the lane's title or detail declares a part: `N of M`, `N/M`, `increment N`,
    `phase N`, or an increment id like `1A`.
  - A third signal — the merged PR touched a doc with an Increments table — is deliberately left
    to the docs gate (§5.3), which runs in CI where the diff is; the daemon does not read diffs.
- **Validation of a non-empty answer:**
  - each id is an existing lane in any state; an `abandoned` one must carry `abandon_reason`;
  - a named lane with no goal is attached to the closing lane's goal; one already on a goal keeps it;
  - if the closing lane has no goal and a named lane has none either, the close is refused with the
    repair: `lane_update {goal_id}` or `team_goal_declare`. This is how a one-lane start becomes a
    Goal the moment it grows a tail.
- **The acceptor sees it.** The acceptance ask includes the `follows_up` answer: named lanes with
  their state, any drops with their reasons, and an explicit `none` when a signal was present.
- **New field:** `abandon_reason` (≤ 280 chars) on `lane_update`, mirroring `park_reason`.
- **Protocol change:** additive fields; `FEATURE_EPOCH` 26 → 27. An older adapter omits
  `follows_up`; on a lane with a signal the server refuses with the repair naming the field, the
  same way as a current adapter that omits it.

### 5.2 Session to-dos: a snapshot on the lane, never a Seed

To-dos change constantly — `TodoWrite` rewrites the whole list many times a session, and most items
are micro-steps. Only what is still unfinished when the session stops means anything.

- **Capture:** each harness's `Stop` hook (turn end) reads the latest to-do state from the
  harness's own transcript and writes the unfinished items. **Last write wins**, which handles the
  list changing mid-session. `SessionEnd` alone is not used: it does not fire on a crash or a
  closed window.
  - Claude Code: `TodoWrite`, and the Task tools' create/update.
  - Codex: `update_plan`.
  - Cursor: `Todo`.
  - Harnesses without a to-do tool: nothing to capture.
- **Where it goes:**
  - the seat has one active lane → `unfinished_todos` on that lane (titles, ≤ 20 items, ≤ 140
    chars each); an empty list clears it;
  - the seat has no lane → seat memory (`team_memory_save`), which orientation already surfaces.
    That is seat memory's defined job: cross-session continuity.
  - several active lanes → the most recently updated one; the snapshot is advisory, not an
    assignment.
- **Why not the trace:** traces (ADR 445/474) record tool names structurally; to-do *text* is content
  and is captured only under content consent. The hook reads the local transcript instead.
- **Privacy:** to-do titles now reach the team's daemon, which only lane titles did before. They are
  the seat's own working notes about team work; the ADR records this step.

### 5.3 The docs gate becomes structural

`pnpm intents:check` (already inside `format:check`) gains a structural rule and wider coverage:

- **Surfaces:** `docs/decisions`, `docs/superpowers/specs`, `docs/superpowers/plans`,
  `docs/design`, plus the existing wiki and roadmap.
- **Rule:** in any section whose heading names Increments or Phases, every row or item must cite
  one of: a lane id (`01M…`), `parked <lane id>`, or `dropped — <reason>`. Checking the table
  rather than the prose means phrasing no longer matters.
- **Existing phrase check:** stays, as a cheap net for loose sentences in ADRs.
- **Baseline:** existing docs start in a burn-down baseline (the `DESIGN_BASELINE` pattern, ADR 296),
  cleared by the Appendix A triage; new docs get no baseline.
- **Retire repo-sourced Seeds:** `intents:ingest` and its script are removed; the 32 open `repo` Seeds
  are triaged into lanes or dropped with a reason. Seeds stay the tray for a human's ideas and Slack.

### 5.4 Guidance, the stale-goal line, and the sweep

- **Guidance.** The musterd skill and `guidance.ts` say it plainly: *"More than one increment?
  Declare a Goal and open every increment's lane now — build, park, or drop each one."* The
  CLAUDE.md translation for `superpowers:writing-plans` gains the same line.
- **Stale-goal line on `team_next`.** An in-flight goal whose open lanes have not changed state in
  `GOAL_STALE_DAYS` (7) gets one line: the goal, its oldest untouched lane, and its age. Advisory,
  derived, never a wake (ADR 258's posture).
- **Weekly sweep.** The existing `sweep` service reruns the audit's cheap checks — goals marked
  `shipped` whose docs still name unbuilt increments; lanes with an S2 marker and no successor;
  undisposed `unfinished_todos` older than 7 days — and posts one team-visible `status_update`
  when it finds anything. Silence means clean.

## 6. What stays uncovered

A plan that exists only in an agent's head — no to-do, no doc, no part marker in a lane title —
cannot be caught structurally. The stale-goal line and the weekly sweep are its backstop, and the
watch (§8) measures whether that is enough.

## 7. Rollout — this work follows its own rule

Goal `nothing-vanishes`, five lanes opened up front and chained:

| # | Lane | Touches |
| --- | --- | --- |
| 1 | `01M3T8MJK8H4M86DZJEBMW6KM8` — this spec, ADR 487, the watch, and the Appendix A triage | docs, board |
| 2 | `01M3T8MQ6ZJQPC2MXD3RCK5YX9` — structural docs gate; retire `intents:ingest` | scripts |
| 3 | `01M3T8MW01JB0JV0MKNB7WVWFZ` — `follows_up` and `abandon_reason`; epoch 27 | protocol, server, MCP, CLI |
| 4 | `01M3T8N0ZBKPBWDYWEEDNH30ED` — to-do snapshot hooks; `unfinished_todos` | CLI hooks, server |
| 5 | `01M3T8N2ZP55HNR99GKDD69RKE` — guidance, stale-goal line, weekly sweep | guidance, server, sweep |

Lane 1 is docs and board only. Lanes 2 and 3 depend on 1; lanes 4 and 5 depend on 3.

## 8. How we will know it worked

A watch, `docs/watches/2026-09-30-nothing-vanishes.md`, `revisit_by` 2026-11-01:

- **Population:** plans, follow-ups and unfinished to-dos created after lane 3 lands.
- **Method:** rerun this spec's four-slice audit over that population.
- **Falsifier:** any declared increment, named follow-up or unfinished to-do with no lane or
  disposition.
- **Pass:** zero such items.
- **Void if:** fewer than five multi-increment plans are created in the window (too little volume
  to judge — the failure ADR 373's first watch hit).

## Appendix A — lost work found 2026-09-30

Every row has a disposition, decided 2026-09-30: nick made the product calls; lane 1 disposed the
clear-cut ones. "To park" rows are open lanes nick is parking — a seat cannot park (ADR 466; see
ADR 487's Consequences) — with the unpark trigger in each lane's detail.

| # | Item | Recorded in | Confidence | Disposition (2026-09-30) |
| --- | --- | --- | --- | --- |
| A1 | Guidance-currency increment 2 (refresh receipt, session-start line) and increment 3 (gate) | ADR 417, spec 2026-09-17 | high | open `01M3TAKF3Y` (inc 2); to park `01M3TAM9XH` (inc 3) |
| A2 | ADR 250 backlog items 2–5: merge loop, capability-fit routing, acceptance absorption, pipe widening | ADR 250, ADR 179 | high | to park `01M3TAJ2S6`, `01M3TAMBQZ`, `01M3TAMDX9`, `01M3TAMGEF` |
| A3 | Incident-convergence wake edge: `wake_on_route` / `wake_on_resolve` are in the schema and CLI but read by nothing in `packages/server/src`; increment 3 CI watcher | ADR 266/271 | high | open `01M3TAM0X3` |
| A4 | Research radar weekly digest: only W36 exists; goal reads shipped | ADR 056, radar README | high | open `01M3TAKHQ4` |
| A5 | Paved road: rest of increment 3 (governed launch, runtime binding) and increment 4 | spec 2026-09-02; ADRs 385/402/411/425 | high | to park `01M3TAMME1` |
| A6 | Interactive Slack ask replies: designed, draft PR #906, lane `01M0E02ZHA` unowned | ADR 289 | high | to park `01M0E02ZHA`; draft PR #906 closed |
| A7 | Genesis snapshot at enrollment | ADR 381 | med-high | to park `01M3TAMSP9` |
| A8 | Cloud-seats increments 2–5 (`host enroll`, Linux footprint, burst, `host move`) — may be superseded by Cloud | spec 2026-08-06 | medium | dropped — superseded by ADR 463 and ADR 475 (`01M3TAN80E`) |
| A9 | Halt-as-revocation, one-button wake, category graduation | design 2026-09-01 codrive-graduation, human-surface | med-high | open `01M3TAKKMM` (halt); to park `01M3TAMVZM` (graduation, one-button wake) |
| A10 | Skills 5, 6, 7, 10, 11, 12 | design skills-that-travel | medium | to park `01M3TAMXRE` |
| A11 | Doorbell webhook SSRF (resolve-and-pin) | ADR 443 | medium | open `01M3T8N55Z` |
| A12 | `presence.session_ended` audit row | ADR 164 increment 2 | medium | open `01M3TAKNCF` |
| A13 | Delivery measurement (governs the wake host's deferral) | spec 2026-09-23 reach-and-boundaries §9 | medium | open `01M3TAKT16` |
| A14 | Live WebSocket push of folded remote events | design deployment-topology §11 | med-low | to park `01M3TAMZQH` |
| A15 | ADR 373 increment 3 (code-comment scan, ADR-status flag) | ADR 373 | med-high | dropped — superseded by ADR 487 |
| A16 | Dangling reference to "ADR 179 increment 5" | ADR 189 | high | fixed: ADR 189 `Follows-up: none` — the loop closed via ADR 191 |
| A17 | Stale `research-intake` roadmap `building:` string | `content/roadmap.data.ts` | high | carried by `01M3TAKHQ4` |
| A18 | Model-family posture on roster/web | ADR 172 | low-med | dropped — low value (`01M3TANBFV`) |
| A19 | Small gaps: single-use claim code (055), `role assign --remove` (261), CLI `next` without `review_debt` (276) | ADRs 055, 261, 276 | low | open `01M3TAM44Q` |
| A20 | Quiet-set increment 2 (`ask` with `meta.eligible`) — parked with no trigger | ADRs 254/260/401 | medium | to park `01M3TAN2BK` |

**Stalled, not lost** (reported, not re-laned): dogfood runs 1–13 open and unowned since
2026-09-14; PRs #864 and #1103 open for five to six weeks; lane `01KZVX17EN` (native harness
phase 2) claimed by nick since 2026-08-12.

**At risk now:** Cloud 1C, 1D and increments 2–8 exist only as a table in the Cloud spec; only 1B
has a lane (fifty). Lane 1 raises this with fifty rather than opening lanes in fifty's plan.

## Appendix B — the 32 repo Seeds, dispositioned (2026-09-30)

ADR 373's `intents:ingest` captured these from forward-reference sentences on 2026-09-04; none was
ever explored. Each was checked against `origin/main` and the board. Lane 2
(`01M3T8MQ6ZJQPC2MXD3RCK5YX9`) retires the repo source and closes these Seeds against this table.

| Seed | Source | Disposition |
| --- | --- | --- |
| `01M1NC4WH30W` | ADR 027:37 per-folder uninstall | done — `packages/cli/src/commands/uninstall.ts` |
| `01M1NC4WHH24` | ADR 047:91 install kickstart | deferred — `Follows-up:` in ADR 047 |
| `01M1NC4WHRJY` | ADR 055:23 follow-ups | open `01M3TAM44Q` (claim code; reclaim wording check) |
| `01M1NC4WJEMB` | ADR 066:64 A/B experiment | dropped — trigger (batond) retired by ADR 194; `Follows-up: none` in ADR 066 |
| `01M1NC4WKQE9` | ADR 091:9 MAST views | done — #117 |
| `01M1NC4WKYDS` | ADR 164:308 last-write-wins slot | done — lanes `01KZAEGF2K`, `01KYQF0STK`; ADRs 336, 455 |
| `01M1NC4WM5J0` | ADR 167:261 typed-act adoption | open `01M3TB3C0D` |
| `01M1NC4WMDVA` | ADR 173:222 `human_required` | done — `store/audit.ts` three-valued |
| `01M1NC4WMPD4` | ADR 173:275 action index | done — migration v25 `idx_audit_team_action_ts` |
| `01M1NC4WQAGP` | ADR 175:70 adoption checklist | done — #565 |
| `01M1NC4WQGY5` | ADR 184:177 exporter | done — `pnpm dataset:export` |
| `01M1NC4WQN5V` | ADR 189:30 "ADR 179 increment 5" | dropped — dangling; closed via ADR 191; `Follows-up: none` in ADR 189 |
| `01M1NC4WQT65` | ADR 189:113 same | dropped — as above |
| `01M1NC4WR11S` | ADR 200:111 custody barrier | deferred — `Follows-up:` in ADR 200 (ADR 341's prototype) |
| `01M1NC4WR6C4` | ADR 232:209 increment 3 | done — lane `01M1Q9D90X` |
| `01M1NC4WRB4Z` | ADR 233:114 picker concentration | deferred — `Follows-up:` in ADR 233 |
| `01M1NC4WRSR8` | ADR 235:71 reviewer monoculture | done — ADR 404 and non-Claude seats on the roster (medium confidence) |
| `01M1NC4WS14Y` | ADR 250:138 backlog | open/parked `01M3TAJ2S6`, `01M3TAMBQZ`, `01M3TAMDX9`, `01M3TAMGEF` |
| `01M1NC4WS92Q` | ADR 259:70 memory migration | done — #787–#800, `docs/wiki/archive.md` |
| `01M1NC4WSMST` | ADR 276:75 team-ask targeting | open `01M3TB3DA2` |
| `01M1NC4WSX0J` | ADR 336:89 co-tenancy | open `01M3TB3EY9` |
| `01M1NC4WT5T0` | ADR 354:110 `wake_lease_source` | deferred — `Follows-up:` in ADR 354 |
| `01M1NC4WTJEY` | ADR 354:114 actuator kill | done — ADR 379, lane `01M1MMHJP3` |
| `01M1NC4WVEY3` | ADR 378:169 | noise — an "Experiment: n/a" line |
| `01M1NC4WVPC9` | wiki agent-permission-enforcement-patterns:21 | deferred — `Follows-up:` in the wiki page |
| `01M1NC4WW09H` | wiki federation-data-census:32 | carried by blocked lane `01M1T3HT88` (ADR 390 §6) |
| `01M1NC4WWJW1` | wiki wake-leases:60 | done — ADR 379 |
| `01M1NC4WWZTS` | roadmap radar M4–M5 | open `01M3TAKHQ4` |
| `01M1NC4WXFAC` | roadmap dataset release | carried by parked lane `01M12FKJBM` |
| `01M1NC4WXTQH` | roadmap toolkit §5 | deferred — existing `Follows-up:` on the roadmap item |
| `01M1ND82R2FX` | roadmap toolkit §5, duplicate | deferred — as above |
| `01M2KNGPCEE6` | ADR 399 falsifier capture | noise — a test capture, not a promise |

Totals: 12 done, 5 laned or carried, 3 newly laned, 7 deferred in their doc, 5 dropped or noise.
