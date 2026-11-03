# 792 — Seats on shift

- Status: accepted
- Date: 2026-11-03

## Context

nick is moving the hub and most seats off his laptop. He set one condition first: he must be able
to drive seats from `/live` or the CLI the way he does from a terminal. The design
(`docs/superpowers/specs/2026-11-02-seats-on-shift-design.md`, approved by nick 2026-11-02) is this
ADR's design record. ADR 790 shipped its first increment: a person's act passes the wake caps.

What is still missing is "keep working on what you have". A seat that finishes one wake goes quiet
until someone sends it something. The only wake for owned work is the ADR 199 dispatch loop, which
is off by default and gated by `flow: auto`.

## Problem

A person who presses Start gets one wake. The seat does not keep going on its claimed lanes, and
nothing bounds a run by the clock or by money, because no such run exists.

## Decision

1. **Start puts a seat on shift; Stop takes it off.** A person's `start` quick action (ADR 779) to
   an agent seat opens today's shift row. A new quick action, `stop`, closes it with reason
   `stopped`. A `stop` steer is delivered like any steer, so a running session reads it at its
   next tool boundary, but it is never a wake reason.
2. **One shift row per seat per day.** The table `shifts` is keyed by (team, member, day), where
   `day` is the calendar date in the seat's working-hours timezone (the member's, else the team's,
   else UTC). Each row records state (`on`, `off`, `ending`), who started it and when, whether the
   Start fell inside working hours, and the stop time and reason.
3. **On shift, claimed work wakes the seat.** A seat on shift that owns a lane in state `claimed`
   or `active` is due a shift wake for it.
   - The wake passes `hourly_cap` and `cooldown_ms` (the ADR 790 filter).
   - It is skipped while the seat has an open question of its own; the answer wakes it.
   - The ADR 306 guards hold: a wake that moved nothing is not repeated for that lane, and the
     continuation cap bounds a run.
   - An agent's act to an on-shift seat is still rationed (ADR 131).
   - On the wire the order is a board work order (`derivation: 'work_order'`, `lane_id`, no act),
     so a host on an older CLI runs it unchanged. Its `composed_line` is the shift line:
     `You are on shift until 18:00 (budget $4.10 left). Your lane `<id>` "<title>" is claimed and
     not done — continue it. Check your inbox first.` The `residency.wake_leased` row records
     `derivation: 'shift'`.
4. **A shift stops on four reasons, and every stop is said.**
   - `hours_end`: the shift started inside working hours, and they have ended. A Start outside
     hours is not ended by the clock.
   - `budget`: the day's spend reached `shift_budget_usd`. Every priced wake since the day began
     counts. An unpriced one counts as the seat's median priced wake of the last 7 days, else $0.50.
   - `no_work`: on shift, and nothing claimed and not done is due, and no question of its own is
     open.
   - `stopped`: a person's Stop.

   The board seat posts one `status_update` per stop, for example `ryder is off shift: hours ended
   at 18:00; 2 lanes still claimed.` A stop while a wake is running sets `ending`, and the row turns
   `off` once the lease ends. Nothing cancels a running wake.
5. **Three policy knobs, in the ADR 131 shape.** Each has a team default and a sparse per-seat
   override:
   - `shift_budget_usd`: default **10**, at most 100, never unset.
   - `shift_start`: `manual` or `auto`; default `manual`.
   - `autonomy`: `ask`, `claim` or `free`; default `ask`.

   `shift_start: auto` and `autonomy` beyond `ask` are stored by this increment and acted on by
   the next (lane `01M6H8C17E`). Working hours are ADR 206's `working_hours`, the same schedule
   dreams read; no new field.
6. **One state everywhere.** `ShiftStateSchema {state, since, until, budget_left_usd, stop_reason}`
   rides `MemberSummary.shift` (null for a human, or for a seat with no shift today). `/live`,
   `musterd status`, `musterd residency status` and `team_status` read that one value.
7. **The spend gates are unchanged.** ADR 611/636 still hold an on-shift seat. The attempt cap
   still binds.

## Consequences

- This is the first enforcement of `working_hours` for work, not only for dreams. ROADMAP's
  "Schedule & lifecycle enforcement — stored, not enforced" now has one enforced use.
- `flow: auto` stays the off-shift trust ramp for the ADR 199 dispatch loop. A shift does not need
  it.
- A client older than this ADR that validates envelopes refuses a `steer` carrying
  `quick_action: 'stop'`. The ADR 135 stale-adapter warning names the fix (rebuild and reload).
- revive's `working_hours` become 09:00–18:00 Mon–Fri, America/Los_Angeles (nick, 2026-11-03),
  set through the seed once this lands.
- Follows-up: lane `01M6H8C17EYMMT8KMDC0QBH0PK` (the recommendation at `ask`, `claim`/`free`,
  `shift_start: auto`) and lane `01M6H8C6QGRZ7Z3D65AD33SZRE` (the `/live` settings and the seat
  reading its own bounds over MCP).

## Observability & Evaluation

- **Traces:** audit `shift.started {by, inside_hours}` and `shift.stopped {reason, lanes_claimed,
  spent_usd}`; `residency.wake_leased {derivation: 'shift', lane_id}`; the board seat's stop line.
- **Eval:** `shift.test.ts` pins the day boundary in the team's timezone, the budget's live sum (a
  late `wake_cost` counts), unpriced wakes, and the stop-due rules. `residency.shift.test.ts` pins
  that a claimed lane wakes an on-shift seat at its cap, that an off-shift seat is not woken for
  it, each stop reason with its line, Start during a live lease, and an agent's act still rationed.
- **Experiment:** for a week after revive's window opens, count shift wakes per seat per day and
  stops by reason. **Falsify:** a seat whose shift runs to `budget` on most days while its lanes do
  not move, which would mean the claimed-work wake spends without progress and the ADR 306 guard is
  not catching it.
