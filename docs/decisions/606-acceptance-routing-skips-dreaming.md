# 606 — Acceptance routing skips a dreaming seat

- Status: accepted
- Date: 2026-10-15
- Lane: `01M50C7QR4C1M0BRAB82VRC5A6`
- Amends: nothing in ADR 494 — the dream fence keeps its shape; this decides the other horn of the tension recorded in [docs/wiki/dream-cannot-verdict-acceptance.md](../wiki/dream-cannot-verdict-acceptance.md)

## Context

A `lane_review` ask is obligation-class (ADR 225), so it rides the immediate wake lane and can
interrupt whatever presence the seat currently holds. A seat woken to dream (ADR 494) is fenced:
`dreamMayWrite` allows insight acts, wiki pages and its own note, and refuses `accept` / `decline`
/ `wait`. So when the acceptance router — or a reap re-route — lands a `lane_review` ask on a seat
whose live presence is a dream, the ask is read and cannot be verdicted. Three dated sightings:
grokbot 2026-10-08, and two reaped `cross_family` asks from big-body on 2026-10-10 (both read,
neither answered, each sitting until it re-routed or morning came).

The lane that recorded them posed the choice: the fence gains a verdict row, or the router stops
offering the ask to a dreaming seat.

## Problem

Routing a verdict to a presence that is constitutionally unable to give one costs real acceptance
latency — on this team, graded `cross_family` first, the dream-heavy seats are exactly the ones the
ladder prefers, so the collision recurred three times in three nights. Every occurrence ends the
same way: the ask parks until the reaper moves it, and the dream's consolidation is disturbed by an
obligation it must leave on the floor.

## Decision

The router skips a dreaming seat. In `selectReviewCandidate`, a live candidate whose current
presence is a dream is excluded with a new recorded reason, `dreaming`, decided by the same
`isDreaming` read the write fence uses. The exclusion joins `ReviewSelectionExclusion` (server
vocabulary) and `EMPTY_POOL_LIVE_EXCLUSIONS` (protocol, `lanes.wire.ts`), so an empty pool can name
the cause the way it names `busy` — a dreaming seat is live-but-ineligible, and the wire already
degrades an unlisted exclusion to generic `live_ineligible` on older builds (lanes.wire.ts's own
forward-compat rule).

The fence gains **no** verdict row. A dream that can `accept` is a dream that judges work, and ADR
494's clean property — a dream consolidates the record and touches nothing else — is worth more
than the latency the exclusion already recovers. The ask is not lost: the seat's next working
session sees it in the ordinary course, and the picker simply chooses the next rung down the ladder
tonight.

## Consequences

- An acceptance submitted while every peer dreams resolves `pick: null` and escalates (human or
  wait) instead of parking on a fenced presence. That is the correct 3am behavior: a verdict that
  cannot be given is not given, and the pool says why (`dreaming`), not a mystery `no_candidate`.
- One extra indexed `presence` read per candidate in the picker, beside the existing
  `hasLivePresence` / `latestAttestedModel` pair — no shape change to the selection loop.
- `ReviewSelectionExclusion` and `EMPTY_POOL_LIVE_EXCLUSIONS` both widen by one value. The second
  is a protocol enum: additive, and the wire reader treats an unknown exclusion as live-ineligible
  by construction, so no version pin moves.
- The wiki page is corrected in the same commit: routed asks no longer reach a dreaming seat. An
  ask addressed to the seat *before* it began dreaming is unchanged — it was already the seat's
  own, and the dream packet never claimed to answer obligations.

## Observability & Evaluation

- **Eval:** the picker's selection audit rows carry the `dreaming` exclusion; the wiki claim's
  falsifier inverts — after any dream night, a `lane_review` ask routed during the window shows no
  dream-presence addressee in the selection snapshot (previously: three sightings in three nights).
  Picker tests pin that a dream-live candidate is excluded `dreaming` and the ladder falls through
  to the next rung.
- **Traces:** the existing selection-snapshot audit (`review.selection`) gains the new reason; no
  new emission points.
- **Experiment:** n/a — the falsifier is checkable from the audit table after one dream night.
