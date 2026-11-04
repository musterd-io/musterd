# 804 — A settled wake releases its reclaim hold

- Status: accepted
- Date: 2026-11-04
- Lane: `01M6M958A8` (goal `coordination-cost`), opened by lazara on
  [finding 031](../research/031-cooperbench-rider7-smoke.md); nick asked for the build in session
- Amends: [753](753-wake-holds-on-the-report.md) (what the `reclaimable` gate state means for a wake's
  own session); builds on [010](010-presence-reclaim.md) (the reclaim hold), [735](735-act-lane-the-seat-ends-its-turn.md)
  (the act lane), [131](131-harness-residency-wake-ledger-host.md) (the wake report)

## Context

A clean websocket close parks the presence row as a *reclaim hold* for the grace window (ADR 010,
`RECLAIM_GRACE_MS`, 45 s): the same member may come back and reclaim its session. `deriveSeatPasses`
reads that hold as its second gate (ADR 753 state `reclaimable`) and leases no wake for a seat whose
session may still be reclaimed. Both are right for a seat a person is driving.

On the act lane (ADR 735) the seat's session *is* the wake. The host spawns the harness, the run
answers the act and exits, the socket closes, and the row is parked for 45 s. The next directed act,
which on a two-seat task arrives inside a minute, now waits out that hold, then the host's poll, the
spawn and the run. Finding 031 measured the cycle on a CooperBench pair at about 80 s a wake, and the
queue behind it: fourteen acts waited 24 s, 37, 46, 56, 128, 129, 144, 187, 201, 268, 278, 317, 335 and
342 s, with `reclaimable` the largest share of every one (up to 247 of 342 s). Nothing was reclaiming
those sessions: the run had exited, the host had reported it, and the hold stood anyway.

## Problem

The reclaim hold protects a session that may come back. A wake's session never comes back: the host
reports its end, and the next wake spawns fresh or resumes by the ADR 131 ladder, never by reclaiming
the socket. Holding the seat for it costs every act-lane act a grace window it cannot use, and the
cost compounds under load.

## Decision

1. **The wake report ends the hold.** When `POST /residency/wake-report` settles a lease
   (`settleWakeLease` returns the row), the daemon sets `held_until = now` on every presence row
   carrying that lease (`wake_lease = <id>`) whose hold is still in the future
   (`releaseWakeHold`, `store/wakeHold.ts`). The reaper frees the row on its next pass, as it would
   have at the end of the grace.
2. **Only that lease's rows.** A session the seat's human holds, or another wake's, is not this
   wake's and keeps its hold. A row with no hold (a live session) is untouched: the report never
   closes a socket.
3. **Nothing else moves.** The grace window, `release`, the `reclaimable` gate and its order in
   `deriveSeatPasses`, the ADR 434 spent-act rule (a completed wake's act is spent, so the same act
   does not re-lease) and the ADR 753 gate record are unchanged. A supplementary report on an
   already-settled lease (the cost record) releases nothing, because `settleWakeLease` returns null.

### Rejected

- **Skip the `reclaimable` gate on the act lane.** It would also skip a hold a person's session left,
  and it moves a rule out of the one place every lane reads it. The hold is the wrong thing to keep,
  not the gate.
- **Resume into the reclaimable session.** There is no socket to resume into once the process has
  exited; the ADR 131 ladder already resumes the transcript.
- **A shorter grace for wake sessions.** A number to tune, and still a wait; the report is the exact
  moment the hold stops meaning anything.

## Consequences

- An act-lane seat's next wake can be leased on the host's next poll after the previous wake reports,
  instead of 45 s later. On finding 031's cycle that is roughly half the per-wake dead time; the
  backlog still grows with spawn and run time, which this ADR does not touch.
- The `wake_gate` record for an act-lane seat should show the `reclaimable` state ending at the
  report rather than 45 s after the close.
- A resumed wake's price (finding 031's other gap, lane `01M6M956WS`) is unchanged by this.

## Observability & Evaluation

- **Traces:** `residency.wake_gate` rows (ADR 753) per seat; `report residency --json` `holds` split
  each act's wait by state. A `reclaimable` share near zero on an act-lane seat after this lands is the
  signature; the ws `release` and reaper paths are unchanged and keep their logs.
- **Eval:** the next act-lane read — finding 030's seats on revive (`reread.py` over `report residency`),
  or a CooperBench smoke pair under rider 7's manifest — reports each wait's `reclaimable` share.
  Expect it under 5 s per wait where it was 24–247 s. Falsifier: a `reclaimable` share that still
  tracks the 45 s grace after a settled wake means the report is not reaching `releaseWakeHold`
  (a lease settled by expiry rather than a report, or a presence row without `wake_lease`).
- **Experiment:** none; the change is mechanical and the read above is a before/after on the same
  seats.
