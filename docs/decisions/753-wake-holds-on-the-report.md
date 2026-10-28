# 753 — Wake holds on the report

- Status: accepted
- Date: 2026-10-28

## Context

[Finding 029](../research/029-act-lane-read.md) read the act lane once and missed: on izzo, six directed
acts waited a median of 175.5 minutes before a wake, against 4.5 s on the launch lanes. Nobody can yet
say why. The host log shows nothing between an act becoming due and its wake, and its lines carry no
time. [ADR 749](749-wake-wait-on-the-report.md) put the wait itself on the report; this ADR puts the
reason beside it.

The reason is decided on the daemon, not the host. Each poll, `deriveSeatPasses`
(`packages/server/src/store/residency.ts`) runs every enrolled seat through a chain of gates and
`continue`s past the seat at the first one that holds it:

1. the seat has a live presence (`hasLivePresence`): a session is on the roster, so the act waits for
   that session to read it;
2. the seat is reclaimable;
3. a lease is already live;
4. the local-session snooze ([ADR 485](485-local-session-deferral-backoff.md)): the host reported a live
   or attended session in the workspace (`residency.wake_deferred`), and the daemon backs off;
5. the hourly cap (`wakesSince(…, 1 h) >= policy.hourly_cap`);
6. on the batched lane, the cooldown. The act lane skips it (ADR 735).

None of these writes anything. The host's deferrals are already audited as `residency.wake_deferred`
with their reason (`local-session-live`, `attended-session-open`, the registry faults). But the snooze
that follows a deferral, and every gate before it, leaves no trace.

## Problem

A wake-latency read can say how long an act waited, but not what held it. It cannot separate "the lane
is slow" from "a session was open the whole time", which is the question finding 029 left open.

## Decision

1. **A gate-state row per seat, written on change.** In `deriveSeatPasses`, the gate that stops a seat,
   or `passed` when none does, is the seat's *gate state* for that poll. The daemon writes a
   `residency.wake_gate` audit row (target the seat, meta `{state, host}`) only when that state
   differs from the seat's last written one. It also rewrites the same state at most once an hour as a
   keepalive. The states are `present`, `reclaimable`, `lease_live`, `snoozed`, `hourly_cap`,
   `cooldown` and `passed`. The last-written state is kept in memory per team and seat, and seeded
   from the seat's newest `wake_gate` row the first time a daemon sees the seat after start. A restart
   therefore writes nothing new for a seat whose state has not changed. No row is written per tick.
2. **Holds on the report.** `WakeSeatCost` gains an optional `holds`: for each act in `waited_ms`, how
   that act's wait divides among the gate states. The report walks the seat's `wake_gate` rows from
   the act's `ts` to its first lease and sums the time spent in each state. A stretch longer than
   75 minutes with no row is `unobserved`: no host polled that seat's label, or the daemon was down.
   The entries are `{act_ts, waited_ms, by_state: {<state>: ms}}`, in `waited_ms` order. The report's
   7-day window bounds their number, as it bounds `waited_ms`.
3. **The printed line.** `musterd report residency` adds one line under each seat that has holds: the
   share of all waited time in each state, largest first, e.g.
   `held: present 71% · snoozed 22% · hourly_cap 7%`.
4. **Visibility** is the same as `waited_ms`: the same readers, derived from rows they can already see.

The field is optional and additive. An older daemon omits it and an older CLI ignores it. The protocol
change is the new optional field on `WakeSeatCost` and the new audit action name.

## Consequences

- A gate change writes a row. Presence flips, a snooze that starts or ends, and a seat hitting its cap
  are each one row. A quiet seat writes at most 24 rows a day, from the keepalive. A busy seat writes
  one more row per state change. The read that this ADR enables will measure the real volume.
- `present` is not a fault: a seat with a live session was never meant to be woken. A read can now
  report the act lane's wait with that time removed. Finding 029's question becomes "of the time the
  seat was free to wake, how long did it wait?"
- The gate order is the existing order, unchanged. Only the first gate that holds a seat is recorded,
  so a seat that is both present and at its cap reads `present`.
- `unobserved` folds together a host that was down and a daemon that was down. The report doesn't tell
  them apart; the host log, or the daemon's own restarts, can.
- The act-lane re-read on this build (lane 01M626J7FQ) amends the manifest before its window opens: the
  R7a rule is unchanged, and the finding reports each wait's `holds` beside it.

## Observability & Evaluation

- **Traces:** one new audit action, `residency.wake_gate`, written on change and hourly. No new span.
  The existing `musterd.residency.wake` span is per actuation and does not change.
- **Eval:** `insights.test.ts` pins how a wait divides across gate rows, including the `unobserved`
  gap and an act whose wait begins before the seat's first row. A residency test pins write-on-change,
  the keepalive and the seed after a restart. `report.test.ts` pins the printed line.
- **Experiment:** the act-lane re-read (lane 01M626J7FQ), pre-registered as a manifest amendment
  before its week opens, reads R7a as before and, beside it, the median wait with `present` and
  `snoozed` time removed. Kill condition, unchanged from that lane: if the wait is still ≥ 15 minutes
  with those removed, the seats come off the act lane and it is retired.
