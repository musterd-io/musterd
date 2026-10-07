# 544 — A joiner learns its hub's pre-genesis lanes, so an acceptance ask or handoff naming one can discharge

- Status: accepted
- Date: 2026-10-07
- Deciders: nick ("do 1" — the re-pinning inbox, 2026-10-07)
- Lane: `01M4C37J78X2411D2W10Z035AY` (goal `seat-continuity`)
- Builds on: ADR 381 (the genesis watermark — a transition older than the log's first `lane.opened`
  advances without a row; §4 named snapshot-at-enrollment as the fix for the gap and did not decide
  it), ADR 325 / 331 (the replicated log and ULID-ordered lane ids), ADR 429 (inbox pinning is an
  obligation rule; an UNKNOWN lane keeps ringing), doorbell clause 7(ii)/(v) and lane 01M2NYBG6D
  (an acceptance ask or handoff whose lane is terminal is discharged — when the lane is known),
  ADR 509 (the pull page already carries hub facts beside events: `nodes`, `seat_nodes`).
- Protocol change: yes (hard rule 1) — `pre_genesis_lanes` on `SyncPullResponse`; a new
  node-authenticated route `GET /teams/:slug/sync/lanes` answering `SyncLanesResponse`.

## Context

ADR 381 drew the edge of replicated history: a lane older than the hub's first logged `lane.opened`
has no birth anywhere in the log, so a transition on it folds as pre-history — the audit row lands,
no `lanes` row is invented, the batch advances. That unwedged the first real joiner. It also left
every pre-genesis lane permanently absent from every joiner, and ADR 381 §4 said so: "fixing that is
snapshot-at-enrollment, pre-registered below, and deliberately not decided here."

The cost surfaced on 2026-10-07 in the inbox. The discharge rules keep an unknown lane's obligation
ringing on purpose — dropping on absence would silence a real obligation (ADR 429; the clause-7 tests
pin it). Measured on ryder's joiner (hub: nick's laptop, log begun ≈ 2026-08-29), over every
unanswered ask or handoff that names a lane:

| the joiner knows the lane…                   | acts |
| -------------------------------------------- | ---- |
| by a `lanes` row                              | 277  |
| by a folded `lane.closed` audit row, no row   | 5    |
| not at all                                    | 101  |

The 277 discharge or stay owed on the lane's real state. The 106 cannot: their lanes live on the hub
and nowhere else, so on every joiner they pin into every bounded inbox read and every wake packet,
indefinitely. Every one of ryder's own eleven stale pins was in this class.

## Problem

A fact the hub holds (the lane's current state) is unreachable from a joiner by construction, and
the inbox's honest rule for an unreachable fact — keep ringing — turns that construction gap into a
permanent obligation on every seat with history.

## Decision

1. **The pull page says how much pre-history the hub holds.** `SyncPullResponse.pre_genesis_lanes` is
   the count of the hub's lanes with `id < lane_genesis` (ULIDs sort by birth, ADR 331). Default `0`,
   so an older hub's page parses and a joiner fetches nothing.
2. **A joiner that holds fewer fetches them, whole.** `GET /teams/:slug/sync/lanes` (machine
   credential, like `/sync/pull`) answers `{ lane_genesis, lanes: Lane[] }` — the hub's pre-genesis
   lanes in their CURRENT state, as the protocol `Lane`. The joiner compares its own count of lanes
   below the watermark with the page's; when the hub has more, it fetches and inserts each row it
   lacks (`insertLaneSnapshot`, `ON CONFLICT (id) DO NOTHING`). Best-effort: a failed snapshot is
   logged and the page still folds; the next page re-compares.
3. **Insert only, never update.** A row this daemon already holds is converging through the fold
   (ADR 325), and a snapshot racing it would be a second writer into lane state. The snapshot fills
   absence; it never corrects presence.
4. **Stateless.** No flag records "snapshotted". The comparison on every page is the whole state,
   so a hub that gains pre-genesis lanes (it cannot — lanes are never deleted and genesis only
   moves earlier if the log is rebuilt) or a joiner that lost rows self-heals on the next page.
5. **Nothing changes in the fold or the discharge rules.** Pre-history still advances (ADR 381 §3);
   an unknown lane still rings (ADR 429). What changes is that the lane stops being unknown: once
   the row exists, clause 7(ii)/(v) read its state and discharge the ask or handoff on the next
   inbox read, and later transitions project onto the row instead of folding `lane_unborn`.

### Rejected

- **Discharge on a folded `lane.closed` audit row alone.** Right for the 5, blind to the 101, and a
  second definition of "the lane is closed" beside the row — the shared-predicate drift ADR 434
  exists to stop.
- **Treat an unknown lane as settled.** ADR 429's reason stands: absence is not evidence, and a hole
  in the fold is exactly when an obligation must keep showing.
- **Ship the snapshot on the pull page itself.** Hundreds of lanes on a page meant for events, on
  every page; the count is the cheap thing to carry every time, the rows the thing to carry once.
- **A `snapshotted_at` marker in `sync_meta`.** Stored state the fold then has to keep honest; the
  count comparison is the fact itself.

## Consequences

- On the next pull after the daemon refreshes, ryder's joiner adopts the hub's ~100 pre-genesis
  lanes; the eleven stale pins discharge as `lane_closed` on the following inbox read, and every
  other seat on that machine sheds its share of the 106.
- The snapshot's size is the hub's pre-genesis lane count, once per joiner. Revive's is in the low
  hundreds; a hub whose log was rebuilt would ship more, once.
- A pre-genesis lane's transitions that folded as pre-history BEFORE the snapshot are not replayed:
  the snapshot carries the resulting state, which is what those transitions produced. The audit
  rows for them were kept by ADR 381 §3 and still stand beside the row.
- ADR 381 §4's pre-registered fix is decided and is not snapshot-at-enrollment: it is
  snapshot-when-behind, which also heals a joiner enrolled before this landed.
- Not in this ADR: the `request_help` and plain `ask` acts with no lane that stay owed because no
  accept or decline ever named them (review requests whose PRs merged months ago). ADR 429 calls
  those a team fact; whether an obligation should have an end is its own question.

## Observability & Evaluation

- **Traces:** log `sync_pre_genesis_lanes_adopted {team, adopted}` / `sync_pre_genesis_lanes_failed`;
  the page field `pre_genesis_lanes`; `GET /sync/lanes` in the hub's request log.
- **Eval:** on a joiner, the count of unanswered lane-bearing asks/handoffs whose lane has no row
  (the table above's two lower rows). Baseline 2026-10-07 on ryder's joiner: 106. Target after one
  pull: 0, with the inbox's `discharged` list naming them `lane_closed`.
- **Experiment:** read ryder's inbox after the daemon refresh and count the pinned July–September
  acceptance asks and handoffs; the eleven should be gone.
