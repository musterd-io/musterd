# 629 — Who asked for a lane

- Status: proposed
- Date: 2026-10-16
- Deciders: the open-and-nudge rule below is the recommendation the lane's author was waiting to confirm
- Lane: `01M4EDCQ2W5QSSX11047XHT12C`
- Builds on:
  - ADR 624: `requested_by` and `attested` on a claim, so "who asked" already has a strength;
  - ADR 109 / ADR 192: `authorized_by` on a merge;
  - ADR 248: a promoted seed keeps `linked_lane_id`.

## Context

A lane records who opened it (`created_by`) and, once it lands, who authorized the merge
(`merged.authorized_by`). It does not record who asked for the work. Those are different people
often enough that the accountability read — asked, then claimed, then accepted, then authorized —
cannot be assembled from the columns that exist.

ADR 624 already records who asked on a *claim*, and it separates a proven request (`attested:
true`, only when the actor is that person) from an unverified one. A lane needs the same
distinction on the lane itself, or "who asked" means two different things.

## Problem

1. **The opener is not the asker.** `created_by` is whoever called `lane_open`. A seed's submitter,
   the sender of a steer, or a person named by the opener can each be the asker, and none of those
   is `created_by`.
2. **Making the field mandatory breaks every caller.** Incident lanes, import, and scripts open
   lanes with no asker. A 400 there forces this lane to change all of them.
3. **A new column does not travel by itself.** Lane birth and lane update are folded field by
   field, and a joiner's snapshot insert lists its columns. An unmapped column stays on the
   machine that wrote it.

## Decision

1. **`requested` on the lane.** Optional `{by, basis, ref?}`. Absent means missing. It is never
   defaulted to the opener, and it is never read as "nobody".
2. **`basis` is how strong the record is.**
   - `act`: `ref` is a steer, an ask, or a handoff, and `by` is that act's sender. The daemon
     fills `by` from the act. A `by` that disagrees is a 400.
   - `seed`: `ref` is a seed, and `by` is that seed's submitter. Promoting a seed writes this
     itself.
   - `self`: the seat writing the record says they asked. `by` is that seat. Naming someone else,
     or attaching a `ref`, is a 400. This is the same rule as ADR 624's `attested: true`.
   - `stated`: the seat names someone else and has no act or seed. That is the seat's word.
3. **A lane with nobody named still opens.** `lane_open` returns the lane. The reply says who
   asked is missing and how to say so (`--self`, `--by`, `--act`, `--seed`, on open or on a later
   update). Nothing that opens lanes today changes.
4. **Once written, the record stays.** A later update may fill a missing `requested`. A different
   value on a lane that already has one is a 409. The same value again is a no-op, so a retry
   succeeds.
5. **Storage and sync.** `lanes.requested_json`, migration v102, both engines, no backfill. The
   birth row carries `requested` when it is set. A later fill is a `lane.updated` change. The
   snapshot insert writes the column. The fold stores what it is given and does not re-check the
   act or the seed.

### Rejected

- **Refusing `lane_open` when nobody is named.** The strongest record, and it breaks incident
  lanes, import, and scripts in this same lane. The readout can measure the share of opens that
  fill the field before anything is made mandatory.
- **Recording the miss and saying nothing at open.** Adoption then depends on seats remembering a
  field the reply never mentions.
- **Reusing `created_by`.** That column is the opener. Overloading it makes the two claims
  indistinguishable, which is the gap this lane exists to close.

## Consequences

- A reader can tell a checked asker (`act`, `seed`, `self`) from a stated one and from a missing
  one without guessing.
- An older daemon ignores `requested` on the way in (zod strips unknown keys) and never sends it,
  so mixed builds keep today's behaviour.
- Increment 2 will read one lane end to end (CLI and /live): asked, claimed, model, accepted,
  authorized, each link verified, stated, or missing.
  Follows-up: 01M534RA2HCAWDT6ZQDVS2FVHJ
- 2026-10-16: that lane is open and claimable, and it depends on this one. The 2026-10-23 date
  stays the Observability eval (a week of opens). It is not a park date for the reader.
- 2026-10-16: tools/list had no spare bytes. `requested` on `lane_open` and `lane_update` is
  undescribed and unbounded in the MCP schema. The protocol schema still bounds `by` and `ref`,
  and the open reply names a miss. The standing-context budget moves by that measured remainder
  and adds no headroom (`docs/perf/context-budgets.json`).
- 2026-10-16: the reader prints five links, in order, on `lane show` and on a card on `/live`
  and `/board` (focused, or opened with the chain control). Each mark is `verified`, `stated`,
  or `missing`. `asked` is verified for `act`, `seed`, and `self`, stated for `stated` or a name
  with no basis, and missing when nobody is named. `claimed` is the current owner, or the latest
  `lane.claimed` owner when the lane is unowned, and is verified or missing. `model` is the
  newest `lane.*` audit row that carries `actor_model` (`LaneEvent.model` /
  `LaneEvent.model_source`, optional, older readers ignore them); `observed` is verified, a
  declaration or a model with no source is stated, and no row is missing. `accepted` is the
  newest `lane.closed` row with `verified: true` and an actor; a self-close is missing.
  `authorized` is `merged.authorized_by` and is stated, never verified: the name is the client's
  word (ADR 109), and an ancestor SHA does not promote it.

## Observability & Evaluation

- **Traces:** `lane.opened` rows whose detail has `requested`, split by `basis`; lanes opened
  with the field absent.
- **Eval**, over opens in the first 7 days after this ships: the share of new lanes with
  `requested` set, by `basis`. A falsifier: if almost every set value is `stated` or `self`, the
  act and seed paths are not the ones seats use, and the nudge is not pointing at a real source.
- **Experiment:** n/a. One rule is shipping. The rejected refusal is not running beside it.
