# 511 — A refused probe from a session that has not joined is not a deaf seat

- Status: accepted
- Date: 2026-10-05
- Deciders: dolly (lane `01M402J3M7`, PR #2081), on nick's direction to take the deaf-seats lane
- Amends: the `interrupt.refused` reason set from lane `01M3TAKT16` (PR #2036) and the §5 verdict
  in `scripts/research/delivery-measurement.ts`
- Relates to: [ADR 391](391-refused-interrupt-probe-attribution.md) (refused probes are attributed),
  [ADR 423](423-interrupt-delivery-records-its-line-and-rail.md) (the rail data the verdict reads),
  [ADR 337](337-agent-http-session-authority.md) (leases are Presence-bound)

## Context

PR #2036 gave each `interrupt.refused` row a `reason` so the deaf-seat lane could learn which cause
dominates before fixing it. The lane planned to wait a week of rows. Two days were enough. Between
2026-10-03 and 2026-10-05, 27 refused probes were recorded. Every reasoned row but one said
`unknown`. The other one said `presence_released`.

Every one of them landed seconds after the seat's previous Presence was `cleared` or `reaped`.
Most of them healed 3–80 s later, when the new session's adapter claimed over its own surface. The
sequence, read from dolly's own session start at 09:34 on 2026-10-05:

1. The SessionStart hook's one-shot CLI claim supersedes the previous session's Presence. Its
   lease row goes with it, because `session_leases.presence_id` is `ON DELETE CASCADE`.
2. The PostToolUse interrupt probe presents `binding.json`'s lease, which is still the previous
   session's. `diagnoseSessionLease` finds no row and says `unknown`.
3. The adapter claims on its first tool call. That is deliberate: a claim at boot would let a
   health probe displace the live session ([ADR 068](068-workspace-scoped-displacement.md)). The
   claim writes its own lease to the binding, and the probe is live again.

## Problem

`unknown` was meant for a token the daemon cannot place. It was absorbing "the session has not
joined yet", which is neither deaf nor a defect: nobody holds the seat, and the session's first
inbox read delivers everything waiting. The §5 verdict counted these rows against raises and read
`refusals are 142% of raises`. That would hold the attended-session deferral on a by-design startup
window.

## Decision

1. **A new reason, `not_joined`.** When the presented lease has no row and the seat has no unheld
   Presence at all, the refusal is `not_joined`. With an unheld Presence on the seat, it stays
   `unknown`. That case is the genuinely deaf one: a binding that missed the live occupant's lease.
   `revoked`, `expired` and `presence_released` are unchanged.
2. **The §5 verdict does not count `not_joined`.** The measurement still counts and prints these
   rows, beside the total. The 25% gate reads the remainder.
3. **The startup window is not closed by claiming at boot.** ADR 068's reason stands: a health
   probe would evict the live session. The window is seconds long and loses nothing.

## Alternatives rejected

- **Keep lease rows after their Presence goes**, so the existing branches could name the cause.
  This changes the lease table's lifecycle for a diagnostic. The live-Presence check answers the
  question that matters, which is whether anyone holds the seat, without touching the schema.
- **Skip the probe until the adapter has claimed.** The CLI cannot tell a pre-claim binding from a
  stale one without the server. That stale-binding case is the deaf seat the probe exists to catch.

## Consequences

- Rows written before this ships keep `unknown`. A read across the boundary should use rows from
  after the merge.
- A sustained `unknown` or `presence_released` now means what it says, and is the lane's real
  signal. Two outliers in the sample stayed unhealed for about nine hours (ghost and big-body,
  2026-10-03 13:29). Under this decision they will read as `not_joined` if no Presence held the
  seat, which is a session that never joined.

## Observability & Evaluation

- **Traces:** each `interrupt.refused` audit row carries `reason`, now including `not_joined`.
  `presence.detached` and `claim.occupied` rows around it show the startup window.
- **Eval:** the dataset is the `interrupt.refused` rows from 2026-10-03 to 2026-10-05. The baseline is
  27 refused probes, all `unknown` or unrecorded but one, against 19 raises. `pnpm delivery:measure
  --days 7` after 2026-10-12 prints the `not_joined` count beside the total. Expected: most
  refusals are `not_joined`, and the remainder is under 25% of raises.
- **Experiment:** falsified if `unknown` stays the largest reason on post-merge rows. That would
  mean bindings miss live leases, which is a real deaf seat and goes back to lane `01M402J3M7`.
