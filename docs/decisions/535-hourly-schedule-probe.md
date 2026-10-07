# 535 — The scheduled full main check probes hourly, so a dropped cron run costs an hour, not four

- Status: accepted
- Date: 2026-10-06
- Deciders: izzo (owns CI spend and the infra it rides on), on nick's go
- Lane: `01M497C1689BP0NE21KVZ10KW5`
- Amends: ADR 508 Decision item 2 (the cron cadence) and ADR 512 Decision item 3 (what a scheduled
  run does)

## Context

ADR 508 put main's full check (both test drivers, coverage, both a11y leaves) on
`cron: '17 */4 * * *'`. ADR 512 made a push to main the main trigger, because the cron had stopped
firing, and kept the cron as a backstop for quiet periods.

The cron fires again, but not reliably. From 2026-10-05 17:10Z to 2026-10-06 11:18Z it should have
fired six times. It fired three times: 17:10Z, 01:18Z and 11:18Z. The 21:17Z, 05:17Z and 09:17Z
runs never started, and 11:18Z matches no slot. GitHub documents that scheduled runs can be delayed
or dropped under load.

The push trigger does not cover the gap. It fires only on a push that changes code and lands more
than 4 hours after the last full check. Code merged in the 4 hours after a full check therefore
waits for the next scheduled run. On 2026-10-06 the last code push was 04:19Z, three hours after
the 01:19Z full check. The two later pushes were docs-only. That code was not fully checked until
11:18Z, seven hours later.

## Problem

Main's full check must reach every code change within a bounded time, even when GitHub drops
scheduled runs. It must also keep ADR 508's cost: at most about one full run per 4 hours while main
moves, and none while it does not.

## Decision

1. **The cron fires hourly: `17 * * * *`.** One dropped run delays the full check by an hour, not by
   four.
2. **A scheduled run runs the full check only when all three hold.** The last full main check is
   at least 4 hours old. Code changed since that check's SHA (any path outside `docs/` and root
   `*.md`; an unknown or unreachable SHA counts as changed). No full check is in flight. Otherwise
   the run skips every gate step and succeeds, as ADR 512's "main has not moved" skip did.
3. **Pushes and `workflow_dispatch` are unchanged.** A manual dispatch still always runs the full
   check.

## Consequences

- The wait for a full check is bounded by about 5 hours (4 hours of age, plus up to an hour to the
  next probe) when GitHub fires the probes, plus an hour for each probe it drops in a row. Before
  this change, one dropped run added 4 hours.
- **A docs-only change no longer starts a scheduled full check.** Under ADR 512, any new SHA did.
  That check could not catch anything the docs gates on the push had not already run.
- About 20 more scheduled runs a day reach the plan step and skip. Each one checks out, reads two
  artifact lists and exits: about a billed minute on Ubicloud's 2-vCPU runner (ADR 517), roughly
  $0.50 a month. Full runs stay at most one per 4 hours.
- A red scheduled run still opens or updates the `ci: main is red` issue (ADR 508). A run that skips
  succeeds, so the probes do not add noise.

- **2026-10-07:** in the 22 hourly slots after merge GitHub started 3 scheduled runs. [ADR 542](542-hourly-probe-dispatched-from-daemon-host.md)
  adds an hourly `probe: true` dispatch from the daemon host and amends item 3: a dispatch with
  `probe` is a probe, one without it still forces the full check.

**Considered and rejected.**

- *A second "watchdog" workflow* that dispatches the full check when it is overdue. It would be a
  GitHub cron too, so GitHub could drop it in the same way.
- *A dispatch from this machine's LaunchAgents* (ADR 512's fallback experiment). That makes main's
  only Postgres check depend on one laptop being awake and online.

## Observability & Evaluation

- **Traces:** none new. The plan step's summary line says why a probe skipped (`probe: …`) or that
  it ran the full check.
- **Eval:** over the seven days after merge, no code commit on main waits more than 6 hours for a
  successful full check. To check: for each main push whose plan reads `suite=true`, find the first
  later run with `full=true` and compare the times. Baseline: 7 hours on 2026-10-06 (04:19Z code
  until the 11:18Z full check).
- **Experiment:** none. Falsifier: a code commit on main that waits more than 6 hours while at least
  half the hourly probes fired.
