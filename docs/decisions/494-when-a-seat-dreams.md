# 494 — When a seat dreams

- Status: accepted
- Date: 2026-10-01
- Deciders: nick (the Multiplayer AI room voted for Dreaming, goal `dreaming`, 2026-10-01), izzo
- Lanes: `01M3X2EJHE` (this ADR, izzo); built on by `01M3X2FTNC` (what a dream sees, ryder) and
  `01M3X2F2ZR` (sleep on `/live`, miley), plus the consolidation and morning-digest lanes
- Builds on: ADR 131 (residency: the wake ledger and the host), ADR 206 (working hours),
  ADR 443 (the doorbell)
- Spec: `docs/demo/multiplayer-ai-2026-10-01/options.md`, Dreaming lane 1

## Context

The room voted for Dreaming: a seat that is idle overnight re-reads the day's record, turns it into
insights and wiki pages, and leaves a digest for the morning. Idle compute becomes memory.

Every wake today has a reason someone else gave it. An `immediate` or `batched` wake answers an act
directed at the seat. A `work_order` wake answers the board (ADR 179). A dream has no sender: it
is a wake the seat takes because it is idle and it is night. That is new, and it must not become a
way for an unattended machine to spend money all night or to wake a human at 3 a.m.

The pieces already exist. Residency (ADR 131) leases wakes under a per-seat policy, prices each
one (`residency.wake_cost`), and reports them (`Report.wake`). Working hours (ADR 206) give each
Member an effective schedule, the Member's own or the Team's. The doorbell (ADR 443) is the one
path by which an act reaches a human's desk, and `ringTargets` is the one function that decides it.

## Problem

Say when a seat may dream, what a night of dreaming may cost, and how it is kept off the doorbell,
in terms the daemon can derive from records it already holds.

## Decision

### 1. A dream is a residency wake with its own derivation

Add `dream` to `WAKE_DERIVATIONS`. The daemon leases a dream exactly like any other wake: one
`wake_leases` row, one `residency.wake_leased`, `residency.woke` or `residency.wake_failed`, and a
`residency.wake_cost` when the host reports one, each with `derivation: 'dream'`. Nothing about a
dream bypasses the ledger, so the host, the deferral guard and the report treat it as a wake.

A dream wake carries a `lane_id` of null and an `act_id` of null. Its wake line says "dream" and
points the seat at its wake context (`team_wake_context`, `wake.kind: "dream"`). What that context
holds, and what a dreaming seat may write, belongs to the dream-packet lane, not to this ADR.

### 2. The gate: idle, and outside working hours

A seat is due a dream only when all of these hold. The predicate is one pure function,
`isDreamDue`, in `@musterd/protocol`; the server passes it the facts.

1. **Enrolled and switched on.** The seat is enrolled for residency, and its effective
   `residency.dream.enabled` is true. The default is false, for every team and seat.
2. **Idle.** The seat has no live presence and the host has not reported a live local session for
   it (the ADR 131 §5 guard still applies at actuation, and a deferral still burns no budget).
3. **Nothing else is due.** No `immediate`, `batched` or `work_order` wake is due for the seat. A
   dream always yields to work someone asked for; it never pre-empts it, and a dream lease is
   never derived in the same pass as another wake for the same seat.
4. **Outside working hours.** `now` is outside the seat's effective `working_hours` (ADR 206: the
   Member's schedule, else the Team's), evaluated in that schedule's timezone. A seat with **no
   effective schedule never dreams**: without one the daemon cannot tell night from a quiet
   afternoon, and guessing would put the seat's spend on the human's working day.
5. **Inside tonight's budget.** See §3.

A **night** is the stretch from the end of one working day to the start of the next working day
in the effective schedule, so a weekend is one long night. Each night is keyed by the date its
working day ended, so the per-night counts in §3 reset when the next working day starts.

ADR 206 said the schedule is informational in v1. This ADR is the first reader that acts on it,
and only to *withhold* a wake: the schedule never makes a seat do anything during the day.
