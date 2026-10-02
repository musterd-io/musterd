# 481 — The sycophancy readout becomes a report projection, with its definitions in the protocol

- Status: proposed
- Date: 2026-09-29
- Lane: `01M3QRD7TFZYX4HKG8QM03PV9X` (goal `research-corpus`)
- Deciders: nick (direction, 2026-09-29), izzo
- Relates to: [ADR 476](476-agent-sycophancy-verify-before-conceding.md) (the two readouts, §4),
  [ADR 294](294-false-claims-ledger.md) (§4: no bare rates),
  [ADR 050](050-insights-report-metrics-waiting-on.md) (the insight report, three altitudes)

## Context

ADR 476 §4 defines two readouts: the unverified concession rate and the challenge decline rate.
Increment 2 (#1846) computes them in `scripts/research/sycophancy-readout.ts`, which reads the local
`musterd.db` directly. First read, 2026-09-29, all time: challenge channel 2 of 6 unverified, phrase
channel 4 of 89, decline rate 0 of 6.

A script that opens the database file works only on the machine that hosts the daemon. A hosted team
(ADR 475) has no local file to open. Every other team measurement already reaches its readers through
the report projection (`ReportSchema`, `musterd report`).

## Problem

The readout needs a surface that works wherever the team runs. The trend also has to stay comparable
across reads: if the script and the server each keep their own copy of the phrase list and the
"names a check" test, the two drift, and a later read measures a different thing.

## Decision

1. **The definitions move into `@musterd/protocol`** as pure functions: the concession phrase list,
   `namesCheck`, and `classify`, exactly as increment 2 shipped them. The script and the server
   import the same code, and changing a definition is a protocol change.
2. **`ReportSchema` gains an optional `sycophancy` block**, optional so that older daemons still parse:
   `{ since, challenge: {unverified, n}, phrase: {unverified, n}, challenge_answers: {declines,
   answered}, by_seat: [{seat, challenge, phrase}] }`. The server derives it at projection time from
   `messages`, the same way it derives `steering`. Nothing new is stored.
3. **`musterd report --altitude team` renders it** under ADR 294 §4's rule: every number shows its
   numerator, denominator and channel, and a per-seat percentage appears only at n ≥ 5. The `ic` and
   `exec` altitudes do not show it.
4. **The script stays.** It becomes a thin caller of the protocol functions and keeps working offline
   against a copied database.

## Consequences

- One definition serves both the script and the report, and a change to it must name its ADR.
- The block is team-visible, but no other surface displays it. Showing seats their numbers is
  [ADR 483](483-per-seat-sycophancy-readout-surface.md)'s decision.
- The known false positive stays: a question answered with `accept` counts in the challenge channel
  (nick → tinybot, 2026-07-09). Fixing it would change the definition mid-trend, so it waits for the
  five-day read. Follows-up: deferred — ADR 476's five-day read (2026-10-04)
- Building waits for that read to show the numbers are worth a surface. Follows-up: deferred —
  ADR 476's five-day read (2026-10-04)

- **2026-10-02 (dolly, lane 01M3QRD7TF):** built ahead of the five-day read at nick's direction —
  the block only measures, so it cannot move the baseline the read takes. Definitions are in
  `packages/protocol/src/sycophancy.ts`; the server derives the block over a 30-day cut
  (`deriveSycophancy`); the script imports the same functions. Parity is held two ways: one shared
  `summariseSycophancy`, and a server test that the row selection (agent authors, this team, the
  cut) matches what the script's query selects on a fixture.

## Observability & Evaluation

- **Traces:** none new. The block is derived at projection time.
- **Eval:** on the same database cut, the report's block and `pnpm sycophancy:readout --json` must
  agree on every count. A parity test in the server suite runs both over a fixture, so a disagreement
  fails CI instead of drifting silently.
- **Experiment:** n/a — this moves an existing measurement to a new surface; the parity test is the check.
- **Falsifier:** a read where the script and the report give different counts for the same cut.
