# 716 — Claim-gated continuation

- Status: accepted
- Date: 2026-10-22
- Builds on: [ADR 588](588-resident-byok-seat.md) (the resident seat; the amendment named this gate
  and left it undecided), [ADR 585](585-verification-rail-claims-at-submit.md) (claims and their
  verdicts), [ADR 306](306-a-breaker-that-never-fired-and-a-chain-capped-by-its-own-successes.md)
  (when a continuation wake is funded)
- Lane: `01M5JJJAGBA1J8ZEBB50GM5Z2S` · Goal: `hosted-seat`

## Context

ADR 588's amendment kept two pi libraries and put the transcript on the daemon's `wake_turns`
rows, so a later wake can be rehydrated onto another model. That path landed with the engine
(`engines/rehydrate.ts`). The same amendment named a second property, claim-gated continuation:
the daemon funds the next wake only after the previous wake's ADR 585 claims verify. ADR 588's
consequences say the rail's confirmed and unconfirmed outcomes are the input, and that the gate
itself was not decided there.

Today a `dispatch_continuation` is funded when the lane has moved since the last wake on that
edge, under the success cap, and suppressed while the owner is engaged (ADR 306, ADR 628). A
submit moves the lane and files `lane.claims_filed` with a verdict per claim. Nothing in that
path reads the verdicts before minting the next continuation, so a wake that filed an
unconfirmed claim still buys another continuation.

## Problem

A resident seat can keep spending continuation wakes after a submit whose claims did not
confirm. The amendment named the hold and did not specify it, so the picker has nothing to
enforce and a reader of ADR 588 cannot tell whether the hold is in force.

## Decision

1. **The gate is `dispatch_continuation` on a seat enrolled with harness `musterd`.** Other
   edges (a handoff, a review, a directed act) are unchanged, and so is every other harness.
   ADR 306 still decides whether a continuation is a candidate. This gate runs after that, on
   candidates ADR 306 would fund.
2. **The input is the lane's latest `lane.claims_filed` row.** That row is the submitter's ADR
   585 reading: `summariseClaims` counts plus the `{kind, ref, verdict}` triples. The acceptor's
   `lane.claims_verified` row is a second reading and is not this gate.
3. **No filing, no hold.** A lane with no `lane.claims_filed` row is funded exactly as ADR 306
   funds it. A submit that files no claims (ADR 585 Decision 6) is the same: there is no
   unconfirmed count to read.
4. **`unconfirmed` holds. `unverifiable` does not.** The next continuation is skipped while that
   latest filing's `unconfirmed` count is above zero. A filing whose verdicts are `confirmed`
   and `unverifiable` only does not hold, so a checker that abstained cannot wedge the seat.
5. **One hold row per filing.** The skip writes `residency.continuation_held` once for that
   `lane.claims_filed` id, with `lane_id`, `edge: dispatch_continuation`,
   `reason: claims_unconfirmed`, and the `unconfirmed` count. Later polls that see the same
   filing write nothing. A newer `lane.claims_filed` row is a new filing: a zero `unconfirmed`
   count lifts the hold, and a positive count holds again and writes one new row.
6. **The picker is the only change.** `packages/server/src/store/residency.ts`, in the
   continuation branch, after the ADR 306 move check and before a lease is minted. The claim
   vocabulary, submit, and accept are unchanged.

## Consequences

- Lane `01M5JJJAGBA1J8ZEBB50GM5Z2S` carries the picker change. This record is the decision.
  Follows-up: none — the picker change is on lane 01M5JJJAGBA1J8ZEBB50GM5Z2S (2026-10-22)
- A directed act still wakes the seat while the hold is up, which is how a decline or a steer
  reaches it. The hold stops the board from buying another continuation off a submit that did
  not confirm.
- Cross-vendor replay is outside this record. It is the rehydrate path ADR 588's engine lane
  landed.

## Observability & Evaluation

- **Traces:** `residency.continuation_held` audit rows, one per `lane.claims_filed` id that
  held a continuation, with `lane_id` and the `unconfirmed` count. `lane.claims_filed` stays
  the reading the gate consumes.
- **Eval:** continuation leases minted for harness `musterd` on a lane whose latest
  `lane.claims_filed` has `unconfirmed` above zero. Baseline is the picker before this gate,
  which mints those leases whenever ADR 306 would. Success is zero such leases. A filing with
  no `unconfirmed` claim, and a lane with no filing, still mint under ADR 306.
- **Experiment:** `residency.test.ts` on both drivers. A musterd seat's continuation is skipped
  after a filing with one `unconfirmed` claim and one `residency.continuation_held` row, and a
  second poll adds no second row. A filing of `confirmed` plus `unverifiable` still mints. A
  lane with no filing still mints. A `claude-code` enrollment with the same unconfirmed filing
  still mints. Falsifier: a musterd continuation lease whose lane's latest filing has
  `unconfirmed` above zero.
