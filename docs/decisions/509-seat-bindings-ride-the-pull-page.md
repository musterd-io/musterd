# 509 — Seat bindings ride the pull page: a joiner's roster knows where every seat lives

- Status: accepted
- Date: 2026-10-05
- Deciders: stanley (lane `01M4578FH0`, PR #2075); found by nick running [ADR 503](503-roster-first-launcher-catalog.md)'s
  experiment on Air 2
- Amends: [ADR 503](503-roster-first-launcher-catalog.md) Decision 5 (how `residence` is derived)
- Relates to: [ADR 358](358-human-seat-trusts-a-set-of-machines.md) (`seat_nodes`), [ADR 356](356-presence-replication.md)
  (node liveness rides the pull page), [ADR 393](393-residency-enrollment-projects.md) (enrollment folds)

## Context

ADR 503 made the launcher roster-first: every member is a row, and `where` it lives comes from
`MemberSummary.residence`, which the server derives from the seat's node binding (`seat_nodes`,
ADR 358). The experiment the ADR ends with — open bare `musterd` on Air 2 and on the hub — was run
on 2026-10-05, the day the chain landed.

The hub read correctly. Air 2 did not: `big-body`, `grokbot` and `compo`, all resident on the hub,
read `nowhere · set up` — the exact row ADR 503 Decision 2 says must never appear, because `set up`
on a seat that lives elsewhere is a silent move.

Two causes:

1. **Bindings never reach a joiner.** `seat_nodes` is written where a claim is arbitrated — the
   hub — and nothing replicates it. Only seven `seat.bound` audit rows exist for twenty-odd live
   bindings, so folding that verb would reconstruct a fraction of the truth. A joiner's roster
   derived `residence` from its own near-empty table and answered `null` for every hub seat.
2. **Residence required wake enrollment.** Increment 1 joined `seat_nodes` to `residency`, so a
   bound seat with no enrollment (`compo`) read `null` on the hub too.

## Problem

A joiner's roster cannot say where the hub's seats live, and a bound-but-not-enrolled seat has no
location anywhere, so the roster-first picker offers to provision seats that already exist on
another machine.

## Decision

1. **The pull page carries the hub's seat bindings.** `SyncPullResponse` gains `seat_nodes`:
   `[{ member, node_id, bound_at }]`, every binding of the team by member **name** (member ids are
   not shared across machines; names are). It rides beside `nodes` (ADR 356 §3) and defaults to
   empty, so an older hub's page still parses.
2. **A joiner replaces its table from the page.** On every pull, before the events, a joiner
   deletes its `seat_nodes` for the team and inserts the page's rows. Replace, not merge: the hub
   arbitrates every bind, so what it holds is the truth. A name this roster does not hold yet, or a
   node id this daemon has not seen, is skipped — a binding decides no act, only what a picker row
   says — so it never wedges the fold. The hub folds nothing; its table is the source. An older hub
   sends none and the joiner keeps what it holds.
3. **Residence is the binding alone.** `seatResidences` no longer joins `residency`. Enrolled or
   not, a bound seat lives on its node; `wakeable` stays the separate fact it always was.
4. **A service seat is never `set up` from the front door.** The `can` table's `setup` applies to
   agents only; a service is provisioned by its own command, a human by `musterd human <you>`.

## Alternatives rejected

- **Fold `seat.bound` / `seat.unbound` as replicated ledger verbs.** The principled shape, but the
  ledger is incomplete for bindings that predate the verb, and a joiner would read a partial truth
  with no way to tell. The page summary is whole by construction, like node liveness.
- **Have the CLI read the hub's roster instead of its loopback daemon's.** Puts the hub's address
  in the launcher and makes `here` depend on a remote read; the time-boxed loopback read is the
  whole point of ADR 491 §5.1.

## Consequences

- Air 2 and the hub derive the same `residence` for every seat; `musterd seats --json` lists the
  same `where` on both. `compo` reads `on mac.lan` with no verb instead of `nowhere · set up`.
- One protocol addition (`SyncPullResponse.seat_nodes`), additive, this ADR its gate.
- The joiner's `seat_nodes` is a projection of the hub's; a local bind on a joiner (a self-claim
  of a seat resident there) is forwarded to the hub first (ADR 358), so the next pull returns it.

## Observability & Evaluation

**Traces.** None new: the pull is already logged, and `replaceSeatBindings` returns applied/skipped
counts the fold could log if a skip is ever suspected.

**Eval.** Success: on a two-node team, `GET /teams/:slug/members` on the joiner carries the same
`residence.node` as the hub for every bound seat, and no `set up` row appears on the joiner for a
hub-resident seat. Baseline: Air 2 on 2026-10-05 — three hub seats read `nowhere · set up`.
Falsify: a joiner's `musterd seats --json` showing `where: nowhere` for a seat the hub lists with a
binding, after one pull tick.

**Experiment.** Re-run ADR 503's experiment on Air 2 after the next refresh.
