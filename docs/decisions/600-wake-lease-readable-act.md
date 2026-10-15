# 600 — A wake lease names only an act its seat can read

- Status: accepted
- Date: 2026-10-15
- Deciders: nick ("take: Wake lease points at an act nobody can read", 2026-10-15)
- Lane: `01M3W7ZGMPR25TD3Q1YD9S1NFB` · Goal: `seat-continuity`
- Builds on: [ADR 209](209-portable-wake-context.md) (packet reads; §4's uniform `forbidden`),
  [ADR 254](254-eligible-sets.md) (an eligible set narrows who owes an answer),
  [ADR 434](434-a-discharged-act-never-re-wakes-its-seat.md) (a `residency.woke` row spends the act),
  [ADR 436](436-wake-edge-is-a-contract-not-a-loop.md) (a side message discharges nothing and,
  once a woke row exists, is not re-leased)

## Context

`claimWakeLeases` copies a candidate's `act_id` onto the lease, and the composed line tells the
seat to call `team_wake_context` with that id. `buildWakeContext` then refuses the packet unless
`mayReadWakeAct` passes: the act is addressed to that member, or it is team-addressed and
`meta.eligible` names them. A plain `@team` / `@broadcast` act stays refused, because the packet
carries the whole thread.

The open directed ledger does not use that predicate. A `request_help` or `handoff` with no
eligible set is owed by the whole non-observer roster, so a cooled seat on the default `both`
lane is handed the id. The seat wakes, calls the tool, and gets `forbidden wake context target`.
Session 19 of seat delta answered with a side message; session 20 was woken on the same id.
ADR 436 clause 5 already says that message is not re-leased — once a `residency.woke` row names
the act. No such row is written when the lease is minted from the still-open ledger and the seat
never occupies it. The suppression is present on the readable path and bypassed here.

ADR 209 §4 returns `forbidden` for a packet read without disclosing whether the target exists.
That is the right answer to a caller guessing ids. It is the wrong answer to the member whose
own wake line just named the id: missing and unreadable are different faults, and only the hub
knows which.

## Problem

A lease can carry an `act_id` that no recipient-scoped read will resolve. The seat is woken to a
pointer it cannot follow, and the next poll mints the same pointer again, because nothing in the
mint path asks `mayReadWakeAct` and nothing in the reply path spends an act the seat could not read.

## Decision

1. `claimWakeLeases` does not mint a lease whose `act_id` is missing from `messages` or fails
   `mayReadWakeAct` for that member — the same predicate `buildWakeContext` uses. The candidate
   is skipped and the poll continues, still one lease per seat. A work-order continuation has no
   `act_id` and is not checked. The composed line therefore never names an id the seat cannot read.
2. `buildWakeContext` tells those two faults apart only for a member already named on a
   `wake_leases` row for that `act_id` (any status, including `reported` and `expired`). A missing
   row is `not_found` (`wake context act is gone`). A row the seat may not read is `forbidden`
   (`wake context act is not readable by this seat`). A caller with no such lease gets the
   existing `forbidden` (`forbidden wake context target`) whether the act is missing or not, so
   existence stays hidden. The lane path is unchanged.
3. An unreadable act stops re-firing because it is never minted. A side message still does not
   discharge the open ledger and still does not write `residency.woke`. The readable-handoff
   behavior in ADR 434 and ADR 436 clause 5 is unchanged.
4. An eligible-set `request_help` or `handoff` (ADR 254) keeps its `act_id` for each named seat,
   because `mayReadWakeAct` admits them. The predicate is not widened to a plain `@team` act.

`not_found` is an existing error code. No protocol schema changes.

## Consequences

- A historical lease that already names an unreadable id is left in place. Its recipient gets the
  distinction in Decision 2. A later poll does not mint another.
- `POST /teams/:slug/wake-context` audits `not_found` as `residency.context_read` with
  `reason: 'missing'`. A guessing caller's deny stays `reason: 'forbidden'` for both a real act
  they cannot read and a missing id, and the HTTP status stays 403.
- ADR 209 Decision §4 keeps its sentence for a guessing caller, with a dated marker pointing here.
- The skip writes no audit row. It is the same silence as the still-true and spent-act skips: a
  pointer the seat cannot read is a resting state, not an event on every poll.

## Observability & Evaluation

- **Traces.** `residency.context_read` deny detail is `{reason: 'forbidden'|'missing', target_kind}`.
  `missing` appears only when a `wake_leases` row for that member names the act. A minted
  `wake_leases.act_id`, when set, is a row `mayReadWakeAct` accepts for that member.
- **Eval.** `packages/server/src/store/residency.test.ts`, describe "an unreadable act_id is never
  leased (ADR 600)": a plain `@team` `request_help` leases nothing, a side message still leaves
  the loop open and still writes no `residency.woke`, an eligible-set `request_help` leases the
  named seat with that `act_id`, and an unreadable candidate is skipped in favor of the next
  readable one. The same file's `buildWakeContext` tests tell gone (`not_found`) from unreadable
  for an ordered recipient and keep a guessing caller on `forbidden wake context target`.
  `residency-http.test.ts` keeps the guessing-caller audit at 403 / `reason: 'forbidden'` and
  records `reason: 'missing'` for an ordered recipient whose act is gone. Removing the mint check
  fails the claim tests; collapsing the two ordered errors fails the context tests.
- **Experiment.** For the week after this lands, count `wake_leases` rows created in that week
  whose `act_id` is a `request_help` or `handoff` with no `meta.eligible` naming `members.name` for
  that `member_id`. The count is 0. A non-zero count means the mint check was bypassed or a second
  writer appeared.
