# 484 — An `accept` answering a `challenge` with no named check gets a warning, never a refusal

- Status: proposed
- Date: 2026-09-29
- Lane: `01M3QTEEW17S73CGBR8N6QX4MN` (goal `research-corpus`)
- Deciders: nick (direction, 2026-09-29), izzo
- Relates to: [ADR 476](476-agent-sycophancy-verify-before-conceding.md) (§1, and "measure first"),
  [ADR 481](481-sycophancy-readout-report-projection.md) (`namesCheck` lives in the protocol),
  [ADR 227](227-roles-as-the-aptitude-layer.md) (warn-only gates while the team is building)

## Context

ADR 476 §1 asks that a critique be answered with the check that was run. It declined a server-side
check on purpose: "a gate on prose is a gate that gets gamed; measure first". The baseline, re-read
on 2026-09-29, found 2 of 6 challenge concessions naming no check. The ledger backfill (#1850) found
no wrong concessions among the 6: the seats concede selectively, but they do not always say why.

## Problem

Guidance alone mostly delays a flip instead of preventing it, per ADR 476's cited literature. The
moment a seat sends an unverified `accept` is the moment a prompt would help. A hard gate there would
teach seats to paste a command they never ran, which is worse than an honest bare concession because
it looks verified.

## Decision

1. **A warning, never a refusal.** When `team_send` receives an `accept` whose `in_reply_to` is a
   `challenge` and whose body fails `namesCheck` (ADR 481), the act is stored as sent. The reply to
   the sender adds one line: `this concedes a challenge without naming what you checked — if you
   checked something, say what; if you didn't, say that`.
2. **The warning goes only to the sender.** It is not shown to the challenger or on `/live`, and it
   is not stored on the act. An audit row (`challenge.accept_unverified`) records that it fired, so
   the eval can count it.
3. **`decline` is not checked.** Holding a position without evidence is a different failure, and
   `decline` had 0 of 6 answers at the 2026-09-29 baseline. A symmetric check would add friction to the behaviour the ADR
   wants more of.
4. **Activation depends on the numbers.** The rail ships switched off and is switched on only if
   ADR 476's five-day read shows the unverified share of challenge concessions has not fallen from
   the baseline. If guidance alone moved it, the rail is not needed and this ADR is marked
   superseded by that result.

## Consequences

- The warning has to be answered in the next act: a seat that concedes again after the warning has
  been told once. There is no second warning on the same thread.
- `namesCheck` is a floor on "verified", not a judgment. A body can pass by citing a file it never
  opened. The eval samples passing bodies by hand for that reason.
- Building waits for the five-day read that decides activation. Follows-up: deferred — ADR 476's
  five-day read (2026-10-04)

## Observability & Evaluation

- **Traces:** the audit verb `challenge.accept_unverified`, with actor = sender, target =
  challenger, detail = `{challenge_id}`, and no body text.
- **Eval:** compare the unverified share of challenge concessions (ADR 481) before and after
  activation, and the share of warned seats whose next act on the thread names a check.
- **Goodhart check:** each month, hand-read 10 bodies that pass `namesCheck`. If more than 2 cite a
  check the thread shows was never run, the rail is teaching fake evidence and comes off.
- **Experiment:** before and after activation, since the rail is on for everyone once activated; the monthly hand audit is the control for fake evidence.
- **Falsifier:** 5 days after activation the unverified share has not moved, or the hand audit
  fails.
