# 483 — A seat sees its own concession numbers, and only its own

- Status: accepted (2026-10-05)
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
   `your concessions (5d): challenge 2/3 unverified · phrase 1/14 · challenges declined 0/3`. It
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
- Depends on ADR 481's projection. Building waits for both that ADR and ADR 476's five-day read.
  Follows-up: deferred — ADR 505's 2026-10-29 read (see the 2026-10-05 note)
- **2026-10-05 — re-keyed to the dispute readout; waits for the 2026-10-29 read** (dolly; lane
  01M3QTEAYH9817YWFF31WM0A4T). The projection this ADR reads is now ADR 505 §8's dispute readout
  (`DisputeReadout` in `packages/protocol/src/sycophancy.ts`, landed by ADR 505 increment 3, which
  absorbed ADR 481's lane 01M3QRD7TF). The `phrase` channel in decision 1's example line is gone as
  a headline, so the line, when built, reads the seat's own dispute row: answered / named a check /
  held, each with its denominator, by `via`. The n ≥ 5 floor, the own-row-only rule and the no
  team-wide display rule stand unchanged. [ADR 505](505-disputes-one-lifecycle-for-contesting-a-claim.md)
  named this ADR "not decided here", to be re-judged at the 2026-10-29 read; at the five-day read
  no seat had 5 disputes answered, so the line would have shown nothing to anyone. Nothing is built
  before the read.
- **2026-10-05 — built; the read moves to a sample trigger** (nick: "10-29 is too far out"; dolly,
  lane 01M3QTEAYH9817YWFF31WM0A4T). The line is safe to ship empty: own row only, silent below 5
  answered, so it switches on per seat as ADR 505's dispute stream (23 review disputes opened in the
  week to 2026-10-05, 0 answered before the inc 2 obligation) produces answers, and the A/B counts
  from the first one. Landed: `NextBrief.own_disputes` (`OwnDisputeRowSchema`, nullable, absent on an
  older daemon), `deriveOwnDisputes` (server, the 5-day slice of `deriveDisputes` for one seat),
  `fmtOwnDisputes` (one string, printed verbatim by `musterd next` and `team_next`), and an arm
  column on `pnpm disputes:readout` (`--team <slug>`). Not on `team_status`: the roster is a
  different projection and the brief is where a seat reads its own state — decision 1's
  "orientation block" is the brief. Decision 1's example line and decision 3's section name are
  in ADR 476's vocabulary; the line as built is the one above, and the section it names is
  "Disputes — a critique is answered with a check" (the 2026-10-05 re-keying note). The read now runs when
  the readout shows ≥ 20 disputes answered team-wide or on 2026-10-19, whichever comes first.

## Observability & Evaluation

- **Traces:** none new. The per-seat arm label lives in seat config, and the line's rendering is
  already covered by the orient read's existing trace.
- **Eval:** after 5 days, compare the two arms on the change in the unverified-concession share and
  the challenge decline rate against each seat's own baseline, and count wrong concessions from the
  ledger (`detection_channel: challenge`).
- **Success:** the seats shown the line move towards naming checks, and wrong concessions do not
  rise.
- **Failure:** the unverified share improves only through surface compliance, meaning a hand audit
  of 10 passing bodies finds a backticked command or file that was never actually checked. That is
  the Goodhart signal, and the line comes off.
- **Experiment:** decision 4's random split of seats, line shown vs not, for 5 days.
- **Falsifier:** no difference between the arms after 5 days, at n ≥ 5 concessions per seat in
  each arm.
