# 483 — A seat sees its own concession numbers, and only its own

- Status: proposed
- Date: 2026-09-29
- Lane: `01M3QTEAYH9817YWFF31WM0A4T` (goal `research-corpus`)
- Deciders: nick (direction, 2026-09-29), izzo
- Relates to: [ADR 476](476-agent-sycophancy-verify-before-conceding.md) (deferred this),
  [ADR 481](481-sycophancy-readout-report-projection.md) (the projection it reads),
  [ADR 294](294-false-claims-ledger.md) (decision 4: never a scoreboard)

## Context

ADR 476 cites one intervention with a large measured effect and no change to the model: showing
agents their measured sycophancy raised majority accuracy by 10.5 points (*Too Polite to
Disagree*). ADR 476 deferred it because it is the one most likely to become a leaderboard, which is
ADR 294's second failure mode. A ranked, per-seat sycophancy number on a shared screen invites
optimizing the number instead of the behaviour.

## Problem

The effect comes from a seat seeing its own pattern. The risk comes from everyone seeing everyone's.
A surface is needed that delivers the first without the second.

## Decision

1. **A seat sees only its own row.** The orientation block (`team_status` and the session-start
   orient read) gains one line, and only when the seat has at least 5 concessions in the window:
   `your concessions (30d): challenge 2/3 unverified · phrase 1/14 · challenges declined 0/3`. It
   carries counts with denominators, and nothing else: no percentage, rank, colour, or comparison to
   other seats.
2. **No team-wide per-seat display.** `/live`, the roster and the board show no per-seat sycophancy
   numbers. The team-level block in the report (ADR 481) is the only place per-seat rows exist, and
   it stays under the n ≥ 5 rule.
3. **The line points at the behaviour, not the score.** It links to the "Answering a critique" guide
   section, whose prescription is to name the check. It never tells a seat to concede less.
4. **A/B during the evaluation period:** half the seats, chosen at random, get the line and half do
   not, recorded per seat. This departs from the paper, which showed agents each other's scores. Own
   numbers only is the cautious arm. Showing each other's would need its own ADR, and only if
   own-only moves nothing.

## Consequences

- A seat below 5 concessions sees nothing. At the current rate (6 challenge concessions all-time
  across the team) most seats will see nothing for weeks, so the phrase channel carries the early
  signal.
- Depends on ADR 481's projection. Building waits for both that ADR and ADR 476's thirty-day read.
  Follows-up: deferred — ADR 476's thirty-day read (2026-10-29)

## Observability & Evaluation

- **Traces:** none new. The per-seat arm label lives in seat config, and the line's rendering is
  already covered by the orient read's existing trace.
- **Eval:** after 30 days, compare the two arms on the change in the unverified-concession share and
  the challenge decline rate against each seat's own baseline, and count wrong concessions from the
  ledger (`detection_channel: challenge`).
- **Success:** the seats shown the line move towards naming checks, and wrong concessions do not
  rise.
- **Failure:** the unverified share improves only through surface compliance, meaning a hand audit
  of 10 passing bodies finds a backticked command or file that was never actually checked. That is
  the Goodhart signal, and the line comes off.
- **Experiment:** decision 4's random split of seats, line shown vs not, for 30 days.
- **Falsifier:** no difference between the arms after 30 days, at n ≥ 5 concessions per seat in
  each arm.
