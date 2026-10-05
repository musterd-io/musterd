# 512 — A push to main runs the full check when the last one is over 4 hours old; the cron is a backstop

- Status: accepted
- Date: 2026-10-05
- Deciders: izzo (owns CI spend and the infra it rides on), on nick's ADR 508 and ADR 510 calls
- Lane: `01M46FEMJG8TV7STAC1SN4KV73`
- Amends: ADR 508 (what triggers main's full check). Relates to: ADR 510 (that check is now the
  only routine run of the PGlite leg)

## Context

ADR 508 moved main's full check (both test drivers, four coverage shards, both a11y leaves) to
`schedule: '17 */4 * * *'`. Twelve hours after it merged (2026-10-05 05:03Z), no scheduled run had
started. Not 08:17Z, not 12:17Z, not 16:17Z.

The repository's history explains it. Since 2026-07-27, steward's weekly cron (`0 8 * * 1`) fired
between 0h45m and 8h32m late. Its last run was 2026-09-28. The run due 2026-10-05 08:00Z had not
started by 16:47Z. No scheduled run of any workflow has started since the repository went private
on 2026-10-02 (`actions/runs?event=schedule`). Whatever the cause, GitHub's cron cannot be what
main's only Postgres check depends on. Since ADR 510, that check is the only routine run of the
PGlite leg.

## Problem

Main's full check needs a trigger that fires. It also needs to cost no more than ADR 508 promised:
about one full run per 4 hours while main is moving, and none while it is not.

## Decision

1. **The last full main check is the newest `coverage-blob-1` artifact from a `main` run.** Only a
   sharded (both-driver) run uploads one. Since ADR 510, a PR shards only when it carries the
   `pglite` label, and filtering on `workflow_run.head_branch == main` excludes those. `plan` reads
   the artifact's creation time and head SHA (the job already has `actions: read`).
2. **A push to main runs the full check when that artifact is over 4 hours old, or missing.**
   Otherwise the push runs `static` + `docs` only, as in ADR 508.
3. **The cron stays, as a backstop.** A scheduled run skips every leaf when the last full main check
   already tested the current SHA. A manual `workflow_dispatch` always runs.

## Consequences

- While main is moving, the full check runs on the first push after each 4-hour gap, and the push
  that triggers it gets a both-driver verdict. Cost is unchanged from ADR 508's intent.
- **When main goes quiet, the commits since the last full check stay unchecked until the next push
  (or until the cron fires, if it ever does).** Overnight that can mean the evening's last 4 hours
  of merges wait for the morning. Those commits all passed SQLite on their PRs, so this is the
  Postgres-only gap ADR 510 accepted, stretched over a quiet period.
- A burst of pushes within the ~10 minutes a full run takes, more than 4 hours after the last full
  check, can start more than one full run: the marker appears only when the first run's shards
  finish. That costs up to about 30 extra billed minutes per burst, at most once per 4 hours.
- If the cron starts firing again, it adds nothing while pushes keep the check fresh. It only fills
  the quiet-period gap above.

_Note, 2026-10-05 (izzo, lane 01M476TFBS)._ **The burst estimate above was low by about 3×.** After
ADR 515 made the full check a single ~21-minute job, five pushes to main between 21:02Z and 21:21Z
each started their own full check (runs 37373451582 to 37375338058), about 85 extra billed minutes.
Each one saw no marker, because the marker is written only at the end. A full check now uploads a
`full-main-check-started` artifact before it does any work. A push or scheduled run that finds a
start marker newer than the last finish marker, and under 45 minutes old, does not start another.

## Observability & Evaluation

- **Traces:** none new. `plan` prints the last full check's time, SHA and age, and its summary says
  when a push became the full check (ADR 512).
- **Eval:** over the three days after merge, every 4-hour window in which main moved contains one
  successful both-driver main run. The `coverage-blob-1` artifacts on `main` are the record.
  Baseline: zero both-driver main runs from GitHub's cron in the 12 hours after ADR 508.
- **Experiment:** none. If quiet-period gaps cost a Postgres-only failure more than a seat-hour, add
  a dispatch from this machine's LaunchAgents (the infra seat's), rather than trusting the cron.
