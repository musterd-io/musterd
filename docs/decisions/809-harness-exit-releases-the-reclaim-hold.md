# 809 — A harness exit releases the reclaim hold on the act lane

- Status: accepted
- Date: 2026-11-05
- Lane: `01M6PA2G02` (goal `coordination-cost`), opened by lazara on
  [finding 032](../research/032-cooperbench-rider7-rerun.md) gap 1; nick asked for the build in session
- Extends: [804](804-wake-report-releases-the-reclaim-hold.md) (the wake report releases the hold) to
  the one session a report never speaks for; builds on [010](010-presence-reclaim.md) (the reclaim
  hold), [735](735-act-lane-the-seat-ends-its-turn.md) (the act lane), [131](131-harness-residency-wake-ledger-host.md)
  §5 (the session attestation the SessionEnd hook posts)

## Context

ADR 804 ends a wake's reclaim hold at the host's wake report, and its two amendments end the holds
the wake's hook sessions park after it. Finding 032 then read the rider 7 re-run with those in place:
after a report the seat read `passed` within 0–9 s on every pair whose timeline was read, and the
`reclaimable` share that remained — 30% of the held wait time, about 40 s of every seat's first wait —
was **each seat's own first session ending**. On a CooperBench pair the arm starts `claude -p` itself;
that session is not a wake, so no lease is minted, no report arrives, and when it exits its 45 s grace
(ADR 010, `RECLAIM_GRACE_MS`) holds the seat's first act-lane wake exactly as a wake's own grace held
the next one before ADR 804.

The daemon already learns the exit. The harness's SessionEnd hook runs `musterd session end`, which
posts `POST /residency/session {event: 'end'}` (ADR 131 §5), stamped `session_ended` on the member and
audited as `residency.session_ended` on the seat. Nothing read that row for the hold.

## Problem

The reclaim hold protects a session that may come back to its socket. A process that has run its
SessionEnd hook is winding down and will not. On the act lane (ADR 735) the seat's session ending is
its turn ending — the next directed act should wake it on the host's next poll — and the hold adds a
grace window nothing can use to every seat's first wake. The same reasoning as ADR 804, one signal
earlier in the seat's life.

## Decision

1. **The seat's exit releases its hold, on the act lane.** Each poll, before the `reclaimable` gate is
   read, `releaseExitedSessionHolds` (`store/wakeHold.ts`, run from `releaseLateWakeHolds`) takes every
   seat with a `residency.session_ended` audit row within the last five minutes, enrolled on the team
   with an effective `lane: act`, and sets `held_until = now` on its parked presence rows last seen
   between one grace before that row's `ts` and `EXIT_SETTLE_MS` (60 s) after it. The reaper frees the
   rows on its next pass, as it would have at the end of the grace.
2. **Only the exiting run's rows.** The span covers the harness's MCP session, which closes before the
   hook posts, and the hook's own CLI claim, which closes after it (ADR 804's second amendment
   measured the order). A row with a live connection is never touched, and a row parked later than the
   settle window is a new session of the seat's own and keeps its hold. _(Amended 2026-11-05: and a
   row **created after the exit row** keeps its hold whenever it parks — every session of the exiting
   run attached before its hook posted the exit, so `created_at <= ts` (+ 2 s ordering slack) is what
   names the run; the span alone let a session started after the exit and parked inside the minute go
   with it; see Consequences.)_ _(Amended 2026-11-05: later the same day, no slack — both stamps are the
   daemon's clock, in a known order, so the bound is `created_at <= ts` exactly; see Consequences.)_
3. **Only the act lane.** A seat on the interrupt or batched lane, or not enrolled, keeps today's
   grace: a person's exit-and-relaunch there is what ADR 010 is for, and ADR 804's first rejected option
   (skip the gate for everyone) stays rejected. The gate itself, its order in `deriveSeatPasses`, the
   grace window and `release` are unchanged.
4. **No new signal.** The hook's existing attestation is the source; no route, schema or migration
   changes. The `audit(team_id, action, ts)` index serves the read.

### Rejected

- **Release at the attestation, in the route handler.** The hook's own CLI claim parks *after* the
  route runs (ADR 804's second amendment found the same order for a wake), so a release there misses
  the last hold every time. The per-poll sweep is where ADR 804 ended up for the same reason.
- **Release on every lane.** It would remove a hold a person's reconnecting session uses, for seats
  the act lane does not describe. The lane is the one place a session's end means "wake me next".
- **Have the host report the arm's first call.** The host did not spawn it; a report for a run it
  never saw would be a fiction in the ledger (ADR 236).

## Consequences

- _(2026-11-05, acceptance read)_ big-body declined the first landing (#3909) on decision 2's promise:
  a person's session started after the exit and parked within the 60 s settle window fell inside the
  span and was released with the run. The exiting run is now also named by creation time — its MCP
  session and its hook's CLI claim both attached before the attestation was posted, a later session
  did not — and the test parks such a session inside the window and shows its hold standing. A
  second read (#3912) found the 2 s ordering slack that landing allowed still released a session
  created inside those 2 s; the slack is gone and the test's post-exit session is created 1 ms after.
- An act-lane seat's first wake can be leased on the host's next poll after its attended session
  exits, instead of up to 45 s later. On finding 032's timelines that is the whole remaining
  `reclaimable` share; what is left of a wait is the seat's own running session (`present`) and the
  host's 10 s poll.
- A seat that is enrolled on the act lane and also driven by a person loses the grace for that
  person's clean exits: a relaunch inside 45 s races the host's next poll for the seat. Finding 030
  found attended act-lane seats hold acts rather than wake for them, so the trade runs the right way;
  the ADR 753 `present` gate still holds a wake while a session is live.
- Nothing changes for a wake's own sessions (ADR 804 covers them) or for any other lane.

## Observability & Evaluation

- **Traces:** `residency.wake_gate` rows (ADR 753) and `report residency --json` `holds`, as for ADR
  804. The signature is a `reclaimable` share near zero on an act-lane seat's *first* wake after its
  attended session ends; the `residency.session_ended` row's `ts` and the first `passed` gate row
  bracket the release.
- **Eval:** the pre-registered re-read in lane `01M6PA2G02` — the rider 7 timelines
  (`timeline.py` over each pair daemon's `report residency`) on the next CooperBench smoke pair or a
  revive act-lane seat: `reclaimable` under 10 s on first wakes where finding 032 read ~40 s.
  Falsifier: a first wake still reading the 45 s grace means the exit never reached the audit
  (`musterd` absent from the hook's PATH, a daemon down at exit) or the seat's effective lane is not
  `act`.
- **Experiment:** none; a before/after on the same seats.
