# Up-next relevance — design

- Date: 2026-10-06
- Author: lazara (lane `01M4977WPYAMZ6TX7WWHVESD1D`), from the design conversation with nick on
  2026-10-06
- Goal: `up-next-relevance`
- Status: approved by nick 2026-10-06; the protocol change is recorded as one ADR when increment 1
  lands (number from `pnpm adr:next`)
- Builds on: ADR 049 (the brief is a derived floor, enriched by the latest handoff), ADR 084 (the
  CLI and MCP render the projection, never re-derive it), ADR 227 (roles are aptitude, never a
  permission; `Member.roles[]`), ADR 256 (goal-attached lanes first; the brief leads with goals),
  ADR 258 (goal status is derived), ADR 272 (role routing is deferred behind measured triggers —
  this spec ranks a read, it does not route), ADR 294 (no bare rates), ADR 373 (`up_next_seeds`
  with its total — the window-plus-total pattern this reuses), ADR 466 (parked lanes are kept, not
  offered), ADR 487 (increments are lanes under the Goal; `stale_goals`), ADR 530 (a lane's
  acceptance inputs are declared, never inferred)

## 1. Outcome

A seat that asks "what next" sees the five open lanes most relevant **to that seat**, drawn from the
**team's** pool, with the count of what the window hid and one reason per line for why each lane is
there. Two seats orienting in the same minute see different top fives, and neither can mistake the
shortlist for the backlog. Whether the ranking beats the current order is measured against the
rows the brief itself writes, and the ranking is reverted if it does not.

## 2. Boundaries

**In:** the `up_next` ordering in `deriveNext`; exclusion of lanes nobody can pick up yet; the
`up_next_total` and `up_next_why` fields on `NextBriefSchema`; the CLI and MCP renders of both; the
`next.offer` / `next.pickup` audit rows; `pnpm next:readout` and its wiki baseline.

**Out, with the reopen trigger named:**

- **Routing.** Nothing here delivers an act to a seat or picks a holder for a role. ADR 272 §5's
  triggers stand untouched; this ranks what a seat already reads.
- **A `lane_open` nudge for a missing `role`.** Three of 74 open lanes carry one today (§3). A
  warn-first line would fire on nearly every open and buy suppressions, not declarations. Reopens
  if increment 3's readout shows the role tier deciding pickups when it does fire.
- **Inference.** No tier reads the diff, the model, the harness, or the lane title. Only declared
  fields rank: `depends_on`, `role`, `goal_id`, `scope`, and the handoff act (ADR 530's posture).
- **Stakes and risk as rank.** Both are shown on the line as they are today and weigh nothing. A
  fresh seat must not be steered toward high-stakes work by a default.
- **The web board.** It reads lanes and goals, not the brief; nothing changes there.
- **The seed window** (`up_next_seeds`) and the `why` handoff slot keep their current derivations.

## 3. What already exists, from the code and the board

- **The ranking today** (`packages/server/src/store/orientation.ts`, `deriveNext`): every lane in
  state `open`, sorted `created_at` ascending, then goal-attached lanes moved ahead (ADR 256),
  then `.slice(0, 5)`. The asking member enters nowhere; only `shipped` is filtered to the seat.
- **One caller.** `GET /teams/:slug/next` in `transport/http.ts` is the only call site of
  `deriveNext`; `deriveNextSummary` is a separate projection and is untouched.
- **The declared fields exist.** `Lane.role` (nullable string, advisory per `lane_open`),
  `Lane.scope` (globs), `Lane.depends_on`, `Lane.goal_id`; `Member.roles` (ADR 227, the array, read
  by `getMemberByName`). `globsOverlap(a, b)` in `store/lanes.ts` is the cheap glob-vs-glob prefix
  test the contention warnings already use.
- **The handoff `why`** is derived from the newest in-play `handoff` addressed to the member or the
  team (not one they sent), bounded by `WHY_SCAN_DEPTH`, retired by `handoffNamedLaneOutOfPlay`.
  It names a lane (ADR 231) and may carry `meta.goal_id` (ADR 049).
- **`stale_goals`** (ADR 487 §5.4) already names, per stalled in-flight goal, its oldest untouched
  lane.
- **The window-plus-total pattern** is already on the brief: `up_next_seeds` and
  `up_next_seeds_total`, rendered as "N of M" on both surfaces.
- **The board on 2026-10-06** (`musterd lanes --json`, 74 open lanes): `role` set on 3; unmet
  `depends_on` on 44; `goal_id` on 74 (so the ADR 256 sort is a no-op); `scope` on 51; age median
  4 days, maximum 30. Across all 833 lanes ever, 36 carry a `role`, and the values mix real roles
  (`platform` 9, `designer` 8, `engineering` 7) with seat names used as roles (`izzo`, `stanley`,
  `dolly`, `wanderer`). The five the brief served this seat were the five oldest launch dogfood
  lanes, with three no-dependency seat-continuity bug lanes in this seat's own recent scope
  hidden behind them.

## 4. Design — increment 1: rank per member, be honest about the pool

### 4.1 The pool

Team-wide, as today: every lane in state `open`. Not a personal backlog. Two seats see the same
candidates in a different order, and every candidate stays visible on `lane_board`.

### 4.2 Exclusion

A lane with any `depends_on` target not in state `done` is **not offered**. The field is documented
as "unowned lanes you could pick up", and a lane whose dependency is unmet cannot be picked up. On
the 2026-10-06 board this removes 44 of 74. The excluded count is reported (§4.5), never hidden.

Parked lanes stay out (ADR 466), and lanes in any other state stay out, as today.

### 4.3 The tiers

Lexicographic: a lane in a higher tier outranks every lane in a lower one; the tie-break inside a
tier is `created_at` ascending, as today, so an unloved lane still surfaces within its tier rather
than being buried by younger ones.

| Tier | Signal | Read from | Why this order |
| --- | --- | --- | --- |
| 1 | **A human pointed here.** The lane is the one named by the brief's live `why` handoff, or is under the `goal_id` that handoff carries. | the `why` derivation already in `deriveNext` | A human's steer outranks every derived signal (ADR 049: the handoff is the human-authored why). |
| 2 | **Role fit.** `lane.role` is in the member's `roles[]`. | `Lane.role`, `Member.roles` | The one declared aptitude signal (ADR 227). Sparse today (§3); ranked, never required. |
| 3 | **Goal motion.** The lane is the oldest untouched lane of a goal in `stale_goals`, or is under an in-flight goal (any live lane) rather than a planned one. Stalled first, then in-flight, then planned. | `stale_goals`, derived goal status (ADR 258) | A goal that stopped needs a hand more than one that is moving; one that is moving needs it more than one not yet started. |
| 4 | **Scope familiarity.** Any `scope` glob of the lane overlaps (`globsOverlap`) any `scope` glob of a lane this member shipped (`done`) in the last 30 days. | `Lane.scope` on both sides | The seat has recent context there. The 30-day window keeps an old speciality from pinning a seat forever. |
| 5 | Everything else. | | |

A lane whose `role` is set to something the member does **not** hold is ranked down to tier 5, never
excluded: roles are aptitude, not permission (ADR 227), and a lane nobody of that role ever picks
up must still reach somebody.

A member with no `roles[]` has no tier 2; a lane with no `role` is never in tier 2. The messy
`role` values on the board (seat names) match nothing and fall through harmlessly.

### 4.4 Protocol

`NextBriefSchema` gains two counts in this increment:

```ts
/** How many open lanes were claimable (no unmet dependency) — `up_next` is a window on them. */
up_next_total: z.number().int().nonnegative().default(0),
/** How many open lanes were withheld for an unmet dependency. */
up_next_blocked_total: z.number().int().nonnegative().default(0),
```

Both default, so an older daemon's brief still parses on a newer client, and an older client
ignores them. `FEATURE_EPOCH` bumps once (30 → 31); an epoch-30 renderer prints the list as
today.

### 4.5 Render

CLI (`packages/cli/src/commands/next.ts`) and MCP (`packages/mcp/src/tools/lanes.ts`), same copy,
same order, as every other brief section:

```
up next — open lanes you could pick up (5 of 30 claimable · 44 more wait on a dependency):
  01M3W7ZG… open "A wake lease can carry an act_id …"  ◆ seat-continuity
  …
```

When `up_next_total` is absent (older daemon) the parenthetical is omitted, not zero-filled. When
every claimable lane is shown, the line reads `(all 3 claimable)`. The blocked clause is omitted
when the count is 0.

### 4.6 Not changed

The cap of five. The `shipped` limit. The seed window. The `why` slot. `deriveNextSummary`. The
ordering of the brief's sections.

## 5. Design — increment 2: the shortlist explains itself

`NextBriefSchema` gains:

```ts
up_next_why: z
  .array(
    z.object({
      lane: z.string(),
      /** Highest tier that placed it, 1–5. */
      tier: z.number().int().min(1).max(5),
      /** One short reason per signal that fired, in tier order; empty for tier 5. */
      reasons: z.array(z.string()),
    }),
  )
  .default([]),
```

One row per lane in `up_next`, same order. `reasons` are fixed strings the server composes, never
free text from a lane body:

| Tier | Reason string |
| --- | --- |
| 1 | `nick pointed here` (the handoff's sender name) |
| 2 | `role: platform` (the matched role) |
| 3 | `goal stalled 9d` / `goal in flight` |
| 4 | `near what you shipped` |

Rendered as a trailing tag on the lane line on both surfaces: `… ◆ seat-continuity · near what you
shipped`. Multiple reasons join with ` · `. Tier 5 lanes carry no tag. Same ADR as increment 1
(recorded in its Consequences), same epoch — a renderer that knows `up_next_total` knows this too.

A seat that sees why it was offered a lane can disagree with the reason. That is the point: a
ranking that cannot be argued with is one that cannot be corrected.

## 6. Design — increment 3: measure, with a falsifier

### 6.1 Rows

Two audit rows (ADR 071's append-only log, `store/audit.ts`), churn class so ADR 478 retention
prunes them:

- `next.offer` — written by `GET /next`: `{member, offered: [{lane, tier}], total, blocked_total}`.
  One row per brief read. The brief is read on every orientation and inbox boundary, so this is
  the densest row the team writes; it is churn class for that reason.
- `next.pickup` — written by `lane_claim` (and `lane_open {claim:true}` for an existing open lane):
  `{member, lane, offered_rank | null, offer_ts | null}` — the rank the lane held in that member's
  most recent `next.offer` within the last 60 minutes, or `null` when it was not offered.

### 6.2 Readout

`pnpm next:readout` (`scripts/research/next-readout.ts`, the pattern of `style:readout` and
`delivery:measure`), under ADR 294's rules — detection channel and denominator on every number, no
leaderboard by seat:

- **Hit rate:** pickups whose lane was in the member's last offer / pickups with any offer in the
  window. By rank.
- **Baseline:** for each `next.offer` row, recompute what the pre-change order (oldest-first,
  goal-attached first, no exclusion) would have served from the same `total + blocked_total` pool
  at that moment — the rows carry enough to rebuild it from the lane table's `created_at` — and
  score the same pickups against it.
- **Tier yield:** of lanes picked up, how many were placed by each tier. This is the number that
  says whether `role` is worth nudging for (§2).
- **Window honesty:** share of brief reads where `up_next_total > 5`, so we know how often the
  count line is doing work.

### 6.3 Falsifier

Fourteen days after increment 1 lands on `revive`, if the ranked hit rate is not above the
oldest-first baseline on the same pickups, the ranking (§4.3) is reverted to the prior order and
the exclusion (§4.2), the count (§4.5) and the why tags (§5) are kept — they are honesty, not
relevance, and stand on their own. The readout result and the decision are recorded as a dated
note in the ADR's Consequences, and a wiki page carries the baseline the day increment 3 ships.

## 7. Alternatives considered

- **A personal backlog per seat** (lanes assigned to a member before claim). Hides the team's
  priorities behind one seat's queue and re-creates the orchestrator the project refuses
  (ADR 227's no-orchestrator stance). Rejected.
- **One identical list for everyone, better sorted.** The first seat to orient takes item one and
  every later seat is offered the same remaining four. Rejected; per-member order over a shared pool
  gets the same visibility without the collision.
- **Weighted scoring** (points per signal, summed). Produces orderings nobody can explain, which §5
  exists to prevent. Lexicographic tiers are arguable line by line. Rejected.
- **Inferring fit from the lane title, the diff, or the seat's model.** Against the declared-only
  line ADR 530 drew for acceptance inputs, and ADR 294's rule that a number carries its channel.
  Rejected.
- **Newest-first tie-break.** Argued in the design conversation; dropped. Age inside a tier is a
  staleness fact, and `stale_goals` already surfaces it at the goal level. Keeping oldest-first
  within a tier changes one thing at a time and leaves the baseline comparison clean.
- **Excluding role-mismatched lanes.** Turns an aptitude into a permission (ADR 227) and strands a
  lane whose role nobody live holds. Ranked down instead.
- **Raising the cap.** A longer list is read less, which is what ADR 373 found with 31 seeds. The
  cap stays; the count says what it hid.

## 8. Limits and verification shape

What this cannot see: a seat that reads the brief and picks up work it was never offered for a
reason the data does not carry (a chat instruction, a Slack message). Those pickups score as
misses for both the ranked order and the baseline, so they do not bias the comparison, but they
cap the hit rate below 1 for reasons outside the ranking.

Tests. Server — `orientation.test.ts`: each tier in isolation and the lexicographic order between
tiers; the unmet-dependency exclusion and both totals; the 30-day familiarity window boundary; the
role-mismatch rank-down; a member with no roles; a lane with a seat name as its `role`; the `why`
handoff placing its lane and its goal's lanes in tier 1. Protocol — schema round-trip with and
without the new fields; the epoch constant. CLI — the `renderNext` frame in `orient.test.ts` with
the count line, the `all N` form, the absent-field form, and the why tags. MCP — the `team_next`
text with the same copy. Increment 3 — the readout script's own test against a fixture of
`next.offer` / `next.pickup` rows, including the baseline reconstruction. Package coverage floors
as usual.

## 9. Increments (each a lane under `up-next-relevance`)

Each increment has its lane (ADR 487), opened 2026-10-06, unowned until its turn, chained by
`depends_on`.

0. **This spec.** Lane `01M4977WPYAMZ6TX7WWHVESD1D` (lazara).
1. **Rank + honest count + ADR** — §4, the ADR, `FEATURE_EPOCH` 31, the three architecture docs.
   Lane `01M497804M3NJCKTCZ017CRSQ9`.
2. **Why tags** — §5, the ADR's Consequences note, renders on both surfaces.
   Lane `01M49783GY1S72PYQKGAQ7C1X6`.
3. **Measure** — §6, the two rows, `pnpm next:readout`, the wiki baseline, the 14-day falsifier
   read scheduled as its own dated lane when this one closes (ADR 487: nothing vanishes).
   Lane `01M4978ADCQ5PXD8S5KBXKDPFA`.

## 10. Not in this spec

Role-addressed sends and the routing resolver (ADR 272 §5). A `lane_open` role nudge (§2). Any
change to how `shipped`, `in_flight`, `stale_goals`, the seed window or the `why` slot are derived.
The web board. Per-human preferences about what a seat is offered — a human steers with a
`handoff` act, which tier 1 already reads; a `steer` enters the brief only through the goal it names (ADR 084).
