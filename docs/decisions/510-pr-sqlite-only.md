# 510 — A pull request runs the SQLite leg only; the PGlite leg runs on main's 4-hourly check

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (on 2026-10-05 said ADR 508's ~$8–9/day was still too much, and chose this option
  over a self-hosted runner), izzo (owns CI spend)
- Lane: `01M46EH1FA5J5JW6PGJ4M9YCDM`
- Amends: ADR 492 (the PR half of its driver filter). Relates to: ADR 479 §3 (every server test on
  both engines), ADR 498 (shards), ADR 508 (the 4-hourly main check)

## Context

ADR 508 removed coverage from every push to main. That left pull request runs as most of what is
still billed. ADR 492 runs both test drivers (SQLite and the PGlite Postgres double) on any PR that
touches `packages/server`, `packages/protocol`, the lockfile, `package.json`, `vitest.config.ts`
or `.github/`. Since the repository went private, the both-driver suite runs as four coverage
shards plus a merge (ADR 498).

Measured from the Actions API, for PR runs created 2026-10-04 12:00Z to 2026-10-05 05:40Z. Billed
minutes are computed per job as wall time rounded up to the minute.

| PR run kind            | Runs | Median billed min (whole run) | Median billed min (coverage) |
| ---------------------- | ---- | ----------------------------- | ---------------------------- |
| both drivers (4 shards) | 20  | 34                            | 27                           |
| SQLite only (1 job)     | 3   | 15                            | 9                            |

20 of the 23 non-docs PRs ran both drivers, because nearly every change touches the server or the
protocol. ADR 492 measured the PGlite leg as roughly 85% of the suite's file-seconds.

## Problem

The PGlite leg exists to catch Postgres-only failures: SQL that SQLite accepts and Postgres
rejects. It catches them before merge, on almost every PR, at about 19 extra billed minutes per run.
Since ADR 508, main gets a full both-driver check every 4 hours. A Postgres-only failure no longer
needs every PR to pay for it to be caught the same day.

## Decision

1. **A pull request runs `MUSTERD_TEST_DRIVER=sqlite`**: one coverage job, no shards, no merge.
   ADR 492's path list no longer decides anything on a PR. The coverage floors are unchanged; the
   SQLite-only job already enforced them on every PR that did not touch the server.
2. **The `pglite` label opts a PR back into both drivers.** Use it when you change store SQL,
   migrations or the Postgres driver, and want the Postgres verdict before merge. The workflow now
   triggers on `labeled`/`unlabeled` as well, so adding the label re-runs CI with both drivers.
3. **Both drivers run on the 4-hourly scheduled main check and on `workflow_dispatch`** (ADR 508).
   This is unchanged. It is now the only routine place the PGlite leg runs.

## Consequences

- A server-touching PR run goes from about 34 to about 15 billed minutes. With most code PRs in
  that group, PR spend should roughly halve. Total spend should fall from about $8–9 a day to
  about $4 a day.
- PR wall time stays about the same. The single SQLite coverage job takes about 9 minutes, against
  about 8 for the slowest of the four shards plus the merge.
- **A Postgres-only failure now shows up on main within 4 hours, as the `ci: main is red` issue**,
  not on the PR that caused it. The PR's author has usually moved on by then, so whoever fixes it
  reads the scheduled run's log. The `pglite` label is the way to avoid this for a change that is
  likely to hit it.
- Any label added to or removed from a PR now re-runs CI. Labels are rarely used here; if that
  changes, filter in `plan` instead.
- Locally nothing changes: unset is still `sqlite`, and `MUSTERD_TEST_DRIVER=both` is still the
  advice for store SQL changes (`docs/wiki/running-the-gates.md`).

## Observability & Evaluation

- **Traces:** none new. Each run's `plan` step summary says which drivers ran and why (label, or
  the ADR 510 default).
- **Eval:** median billed minutes per PR run, computed as in Context. Baseline: 34 (both drivers).
  Success: a median of 18 or less across the first 20 non-docs PR runs after merge, and total daily
  billed minutes under 600 over three full days.
- **Experiment:** the falsifier is a `ci: main is red` issue caused by a Postgres-only failure that
  a both-driver PR run would have caught. One such case is expected and acceptable. Two in a week
  means the `pglite` label is not being used where it should be. Then make the label automatic for
  PRs that touch `packages/server/src/store/**` or migrations, before restoring both drivers on
  every PR.
