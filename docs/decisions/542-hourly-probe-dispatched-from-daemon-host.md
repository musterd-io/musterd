# 542 — The hourly full-main-check probe is also dispatched from the daemon host, because GitHub's cron fired 3 of 22 slots

- Status: accepted
- Date: 2026-10-07
- Deciders: izzo (owns CI spend and the infra it rides on), on nick's go (2026-10-07)
- Lane: `01M4BJW0M6EYCWFCR0ZG5XX1PJ`
- Amends: ADR 535 Decision item 3 (what a `workflow_dispatch` does), and reverses its rejection of
  "a dispatch from this machine's LaunchAgents"

## Context

ADR 535 made GitHub's cron fire hourly (`17 * * * *`) so that one dropped scheduled run would cost
an hour, not four. It landed 2026-10-06 18:41Z. In the next 22 hourly slots, to 2026-10-07 16:17Z,
GitHub started 3 scheduled runs: 23:03Z, 02:23Z and 10:15Z. None of them was near its :17 slot.
The workflow was active throughout. Dropping 19 of 22 is far worse than the 3 of 6 that ADR 535 was
written for.

The cost showed up the same night. Main went red at 721716df (the ADR 539 query, which Postgres
rejects). Only the full check runs the PGlite leg on main, and only scheduled runs reached it, so
the red was reported at 23:03Z, 02:23Z and 10:15Z: gaps of 3 and 8 hours between checks.

ADR 535 considered a dispatch from this machine's LaunchAgents and rejected it: "That makes main's
only Postgres check depend on one laptop being awake and online."

## Problem

Main's full check must reach a code change within a bounded time when GitHub drops most scheduled
runs. ADR 535's cost and decision rules (full check only when the last one is over 4 hours old,
code moved and none is in flight) stay as they are.

## Decision

1. **A `workflow_dispatch` with `probe: true` is a probe.** CI's pick step treats it exactly like a
   scheduled run: it runs the full check only under ADR 535 item 2's three conditions and skips
   every gate step otherwise. A failed probe opens or updates the `ci: main is red` issue, as a
   scheduled run does. A dispatch without `probe` still always runs the full check.
2. **The daemon host dispatches a probe every hour, at :47.** `scripts/ci/main-probe.sh install`
   writes the LaunchAgent `studio.sandrise.musterd-ci-probe`, which runs
   `gh workflow run ci.yml --ref main -f probe=true`. The :47 slot is half an hour off the cron, so
   when both fire the second sees the first's check in flight or under 4 hours old and skips.
3. **The cron and the push trigger stay.** The dispatch is added to them; it replaces neither.

ADR 535's objection does not hold for an added trigger. When the laptop is off, the cron and the
push trigger work as they do today, so the result is no worse than ADR 535.

## Consequences

- With the laptop awake, the wait for a full check is bounded by about 5 hours (4 hours of age, plus
  up to an hour to the next probe), whatever GitHub does with its cron.
- About 24 more runs a day reach the pick step and skip, about a billed minute each on Ubicloud's
  2-vCPU runner (ADR 517), roughly $0.50 a month. Full runs stay at most one per 4 hours.
- One more LaunchAgent on the shared laptop. It runs once an hour for about a second, needs `gh`
  logged in, and logs one line per dispatch to `~/.musterd/ci-probe.log`
  ([wiki](../wiki/main-full-check-probe.md)).
- A missed slot while the laptop sleeps fires once on wake, which is the right behaviour: the probe
  decides whether anything is due.

**Considered and rejected.**

- *Replace the cron with the dispatch.* The laptop would then be the only probe, which is the
  objection ADR 535 raised.
- *A watchdog workflow on a second GitHub cron.* GitHub drops it in the same way (ADR 535).
- *Run the full check on every push to main.* That reverses ADR 508's cost reduction (44% of
  billed minutes) to fix a scheduler problem.

## Observability & Evaluation

- **Traces:** none new. Each dispatch writes a line to `~/.musterd/ci-probe.log`; each probe run
  writes the existing `plan:` line to its job summary.
- **Eval:** over the seven days after install, `gh run list -w ci.yml -e workflow_dispatch` shows a
  run in at least 90% of the hours the laptop was awake, and no code commit on main waits more than
  6 hours for a successful full check (ADR 535's measure).
- **Experiment:** none. Falsifier: a code commit that waits more than 6 hours while the log shows
  hourly `dispatched probe` lines.
