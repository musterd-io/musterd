# 508 — A push to main runs static + docs; full coverage and a11y run on main every 4 hours

- Status: accepted
- Date: 2026-10-04
- Deciders: nick (raised the GitHub Actions budget from $15 to $30 on 2026-10-04, the second raise
  in two days, and approved this change the same evening), izzo (owns CI spend)
- Lane: `01M456C1J6299M6FF39NTSERZ3`
- Relates to: ADR 106 (`gates` is the one required check), ADR 492 (test-driver scoping), ADR 498
  (coverage shards), ADR 499 (leaves run where their inputs changed)

## Context

The repository has been private since 2026-10-02, so Actions minutes are billed. The org spending
limit stopped CI on 2026-10-03 at 19:44Z. nick raised it to $15, and on 2026-10-04 he raised it to
$30.

Measured on 2026-10-04 from the Actions API. Billable minutes are computed per job as the
wall-clock time rounded up to the minute, the way GitHub bills them; the per-run `timing` endpoint
returns zero for this repository.

- Since the 10-03 19:44Z raise there were 81 runs and 1,724 billed minutes, about $14 at $0.008 a
  minute. That is the $15.
- In the 16 hours to 2026-10-05 04:40Z there were 1,261 billed minutes, about $15 a day.
- A full run bills about 37 minutes. Coverage is 29 of them: four shards of 6.2–7.8 minutes each,
  plus the merge (runs 37263615000 and 37264161587).
- **A push to main was 44% of the minutes (555 of 1,261).** That run is the squash commit of a PR
  whose own run had already passed coverage, and the a11y leaves where they applied, on the same
  change.
- **Cancelled runs billed 148 minutes.** `concurrency: ci-${{ github.ref }}` with
  `cancel-in-progress: true` puts every push to main in one group. A burst of merges cancels the
  in-progress run each time, and that run bills what it used and gives its commit no verdict.

## Problem

Every change paid for coverage twice, and the second payment mostly bought a duplicate verdict.
That duplicate has one real job. It catches two PRs that each pass alone but fail combined (a
merge skew), and it runs the PGlite leg on changes whose PR ran SQLite only (ADR 492). Neither job
needs to run on every push.

## Decision

1. **A push to main runs `static` and `docs` only.** `plan` sets a new `coverage` output to false
   and `a11y` to false on `push`. `gates` sanctions those skips by name, as it already does for
   ADR 499's skips. Build, typecheck, lint, the byte budgets and the docs gates still run on every
   main commit, for about 6 billed minutes.
2. **Full coverage (both drivers, four shards) and both a11y leaves run on main every 4 hours**,
   at `cron: '17 */4 * * *'`, and on `workflow_dispatch`. A scheduled run first asks the Actions API
   for the SHA of the last completed scheduled run. If main has not moved since then, `plan` skips
   every leaf and `gates` sanctions it. That costs about 2 billed minutes.
3. **A red scheduled run opens or updates one GitHub issue titled `ci: main is red`**, naming the
   run (`main-red` job, `issues: write`). No PR waits on the scheduled run, so without the issue
   nobody would see it go red.
4. **Main runs do not cancel each other.** The concurrency group is keyed by event and SHA for
   anything except a pull request. `cancel-in-progress` is true only for a pull request, where a
   newer push really does supersede the older one.

`gates` stays the one required check, and PR runs are unchanged.

## Consequences

- Expected spend falls from about $15 a day to about $8–9 a day. Per day: main pushes cost about 6
  minutes each instead of 37, and there are six scheduled runs at 2–40 minutes. Cancelled-run
  waste goes to zero on main.
- **Detection is slower.** A merge skew, or a PGlite-only failure from a PR that ran SQLite only,
  now shows up on main within 4 hours, not within about 10 minutes. It surfaces as the
  `ci: main is red` issue, not as a red check on the merge commit. In that window other PRs can
  land on a broken main. Their own PR runs test the merge commit against main, so a skew that
  breaks the build or tests usually shows up there first.
- The ADR 498 measurements of main-run wall time stop updating, because main no longer runs
  coverage per push. The scheduled runs are the new series.
- `docs/wiki/running-the-gates.md` and `docs/architecture/03-server.md` now say the PGlite leg
  runs on the scheduled main run, not on every push.

## Observability & Evaluation

- **Traces:** none new. Every scheduled run's `plan` summary says whether it ran or skipped, and
  why. The `main-red` issue is the record of a red scheduled run.
- **Eval:** billed minutes per day, computed per job (wall time rounded up) from the Actions API,
  as in the Context section. The baseline is 1,261 minutes in 16 hours (about 1,890 a day). Success:
  under 1,150 a day across the first three full days after merge, with ADR 492's both-driver
  coverage still passing on main at least once in every 4 hours in which main moved.
- **Experiment:** none designed. The falsifier is a `ci: main is red` issue whose failure a
  per-push coverage run would have caught, and that cost more than one seat-hour before it was
  fixed. If that happens twice in two weeks, shorten the schedule (for example to every 2 hours)
  before restoring coverage on every push.
