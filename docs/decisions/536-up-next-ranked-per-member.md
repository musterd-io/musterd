# 536 — `up_next` is ranked per member over the team pool, excludes what cannot be picked up, and says what it hid

- Status: accepted
- Date: 2026-10-06
- Deciders: nick (approved the design 2026-10-06), lazara (lanes `01M4977WPYAMZ6TX7WWHVESD1D` spec,
  `01M497804M3NJCKTCZ017CRSQ9` increment 1)
- Spec: `docs/superpowers/specs/2026-10-06-up-next-relevance-design.md`
- Goal: `up-next-relevance`
- Relates to: ADR 049 (the brief is a derived floor enriched by the handoff why), ADR 084 (one
  derivation, two renders), ADR 227 (roles are aptitude, never permission), ADR 256 (goal-attached
  lanes first — kept as the within-tier rule), ADR 258 (goal status is derived), ADR 272 (role
  routing is deferred behind measured triggers — this ranks a read, it routes nothing), ADR 373
  (`up_next_seeds` + its total, the window-plus-total pattern), ADR 466 (parked lanes are kept, not
  offered), ADR 487 (`stale_goals`; increments are lanes under the Goal), ADR 530 (declared, never
  inferred)

## Context

`team_next` / `musterd next` answers "what should I do" with `up_next`: every lane in state `open`,
sorted oldest first, goal-attached lanes moved ahead (ADR 256), cut at five. The asking seat entered
nowhere — only `shipped` was filtered to the member. So the shortlist was identical for the whole
team, and the first seat to orient took item one while every later seat was offered the same
remaining four.

Measured on revive, 2026-10-06, 74 open lanes: 44 carried an unmet `depends_on` and could not be
picked up; 3 carried a `role`; all 74 were goal-attached, so the ADR 256 sort was a no-op; age
median 4 days, maximum 30. The brief served this seat the five oldest launch dogfood lanes and said
nothing of the other 69 — among them three no-dependency bug lanes in the seat's own recent `scope`.
A seat reading that list believed it was the backlog.

Across all 833 lanes ever opened, 36 set a `role`, and the values mix real roles (`platform`,
`designer`, `engineering`) with seat names (`izzo`, `stanley`). The declared aptitude signal exists
in the schema (ADR 227) and is barely used.

## Problem

Make the five a seat sees the five most relevant **to that seat**, drawn from the **team's** pool,
and make it impossible to mistake the window for the whole — using only declared facts, without
building the routing ADR 272 deferred, and in a way that can be shown wrong.

## Decision

1. **The pool stays team-wide; the order is the seat's.** `up_next` ranks every `open` lane for the
   asking member. Two seats see the same candidates in different orders; every candidate stays on
   `lane_board`. Not a personal backlog, not an identical list.
2. **A lane with an unmet `depends_on` is not offered.** "Lanes you could pick up" is literal: a
   dependency not in state `done` withholds the lane. A dependency naming no lane on the board does
   not block (the contention warnings' rule). Parked lanes stay out (ADR 466).
3. **Lexicographic tiers, declared signals only.** Higher tier wins outright; inside a tier,
   goal-attached first (ADR 256, kept), then `created_at` ascending.
   - Tier 1 — a human pointed here: the lane the brief's live `why` handoff names (structured
     `meta.lane_handoff.lane` or a prose id resolving to exactly one lane — the same resolution as
     the out-of-play test), or any lane under the handoff's `meta.goal_id`.
   - Tier 2 — role fit: `Lane.role` is in the member's `roles[]`.
   - Tier 3 — goal motion: the oldest untouched lane of a goal in `stale_goals`, then any lane under
     an in-flight goal. A planned goal does not place here.
   - Tier 4 — scope familiarity: a `scope` glob overlaps (`globsOverlap`) the `scope` of a lane this
     member shipped in the last 30 days (`FAMILIARITY_WINDOW_MS`).
   - Tier 5 — the rest.
   A `role` the member does **not** hold ranks the lane in tier 5, never out (ADR 227: aptitude, not
   permission). A human pointer wins even over that mismatch. A seat-name used as a role matches
   nothing and falls through.
4. **Two counts ride beside the window.** `NextBriefSchema.up_next_total` (claimable open lanes)
   and `up_next_blocked_total` (withheld for a dependency), both `.default(0)`. The CLI and MCP
   render one parenthetical in the same words: `(5 of 30 claimable · 44 more wait on a
   dependency)`, `(all 3 claimable)`, or nothing when a daemon reports neither. `FEATURE_EPOCH`
   30 → 31.
5. **Nothing is inferred.** No tier reads a title, a diff, a model or a harness (ADR 530's line).
   Stakes and risk are shown on the line and weigh nothing. There is no `lane_open` nudge for a
   missing `role` — three of 74 lanes carry one, and a warn-first line would fire on nearly every
   open; increment 3's readout decides whether to add one.
6. **This ranks a read; it routes nothing.** No act is delivered because of a role, no holder is
   picked. ADR 272 §5's triggers stand.

## Alternatives rejected

- A per-seat backlog (assignment before claim) — re-creates the orchestrator the project refuses.
- One identical list, better sorted — the first seat drains it for everyone.
- Weighted scoring — an order nobody can explain, which increment 2's reason tags exist to prevent.
- Inferring fit from title, diff or model — against ADR 530 and ADR 294.
- Newest-first tie-break — age inside a tier is a staleness fact `stale_goals` already carries;
  changing one thing at a time keeps the baseline comparison clean.
- Excluding role-mismatched lanes — turns an aptitude into a permission and strands a lane whose
  role nobody live holds.
- Raising the cap — a longer list is read less (ADR 373's 31 seeds); the count says what it hid.

## Consequences

- `deriveNext` reads the member's roles and the handoff's named lanes, and derives `up_next` after
  the `why` and the goals. `rankUpNext` / `upNextTier` are pure and exported; the tiers are tested
  in isolation (`orientation.test.ts`) and end to end through `deriveNext`.
- `handoffNamedLaneIds` (`store/delivery.ts`) exposes the lanes a handoff names, by the same rules
  the out-of-play test uses, so the lane ranked first is the lane the `why` slot is about.
- Increment 2 (lane `01M49783GY1S72PYQKGAQ7C1X6`) adds `up_next_why` — one fixed reason per offered
  lane — under this ADR and epoch; increment 3 (lane `01M4978ADCQ5PXD8S5KBXKDPFA`) writes
  `next.offer` / `next.pickup` audit rows and ships `pnpm next:readout`.
- _Note, 2026-10-06 (lazara, increment 2 landed)._ `NextBriefSchema.up_next_why` — one row per
  `up_next` entry, same order: `{lane, tier (1–5, integer; the 3.5 sub-order stays a sort detail),
  reasons[]}`. `upNextReasons` (`store/orientation.ts`) composes every signal that fired, in tier
  order, from the spec §5 table: `<sender> pointed here` (`a human pointed here` with no live
  handoff), `role: <role>`, `goal stalled <N>d` / `goal in flight`, `near what you shipped`. A
  tier-5 lane, and a lane whose `role` the member lacks, carry no strings (no signal fired). Both
  renders append ` · r1 · r2` to the lane line; nothing on an epoch-30 daemon (`.default([])`). No
  epoch bump: epoch 31 already names increments 1–2 together, as the spec said.
- _Note, 2026-10-06 (lazara, increment 3 landed)._ `deriveNext` writes one `next.offer` audit row
  per brief read (actor = the member; churn class, ADR 478): `{offered: [{lane, tier}], baseline:
  [lane ids], total, blocked_total}`, where `baseline` is the window the pre-ADR-536 rule would have
  served from the same board (`baselineUpNext`) — stored, so the readout never reconstructs the
  board at offer time. Two departures from spec §6.1–6.2, both the smaller change: there is **no
  `next.pickup` row** — the existing `lane.claimed` row with `kind: 'claim'` is the pickup, and
  `pnpm next:readout` (`scripts/research/next-readout.ts`) joins it to the actor's newest offer in
  the hour before; and the baseline rides in the offer row rather than being rebuilt. The readout
  reads the live store plus the ADR 478 archive. Baseline page: `docs/wiki/up-next-relevance.md`;
  the read is due 2026-10-20.
- **Falsifier (spec §6.3).** Fourteen days after this lands on revive, if the ranked order's pickup
  hit rate is not above the oldest-first baseline recomputed on the same rows, decision 3 is
  reverted and decisions 2 and 4 are kept — they are honesty, not relevance. The reading is
  recorded here as a dated note.

## Observability & Evaluation

- **Traces:** none in this increment. Increment 3 (lane `01M4978ADCQ5PXD8S5KBXKDPFA`) adds the
  `next.offer` audit row — `{member, offered: [{lane, tier}], total, blocked_total}` per brief
  read — and `next.pickup` with the offered rank of each claim. Until then the observable is the
  brief itself: `musterd next` on two seats with different roles or shipped scopes shows different
  first lines and the same `up_next_total`.
- **Eval:** `pnpm next:readout` (increment 3) — pickup hit rate by rank against the oldest-first
  baseline recomputed on the same rows; tier yield (which tier placed the lanes that were picked
  up); share of brief reads with `up_next_total > 5`. Pass: ranked hit rate above baseline at 14
  days after this lands on revive.
- **Experiment:** the baseline comparison above is the experiment — same pickups scored against the
  pre-change order. Falsifier: ranked hit rate at or below baseline at 14 days reverts decision 3
  (the tiers) and keeps decisions 2 and 4 (exclusion and counts), recorded here as a dated note.
