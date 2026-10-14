# 492 — The PGlite test leg runs where it can catch something

- Status: accepted
- Date: 2026-10-01
- Deciders: nick (asked whether every seat should be paying for the PGlite leg; approved this shape)
- Lane: `01M3WMAM5GGH0P3Z7TKZZ1VH47`
- Relates to: ADR 479 (two store backends — decision 3, the store suite on both drivers), ADR 106
  (one git workflow, `gates` as the required check)

## Context

ADR 479 decision 3 put the server's store suite on both drivers — better-sqlite3 and the PGlite test
double — in CI, so the two SQL dialects cannot drift silently. Plan 1A made `both` the default
everywhere: `testDriverKinds()` returns `['sqlite', 'pglite']` unless `MUSTERD_TEST_DRIVER` says
otherwise, and CI's `coverage` job pins `both`.

On 2026-10-01 nick asked whether every seat should be running those tests. Two costs answer it:

- **CI.** `coverage` is the critical path of every PR, 14–16 min, and it has no path filter. A
  docs-only PR (`docs/deck-appendix`, run 2026-10-01) paid 14 min, the PGlite half of the server
  suite included, for a change no server test can see.
- **The laptop.** About a dozen seats share one 8 GB machine. Any seat that runs server tests runs
  the PGlite half by default. That afternoon the load average reached 186 and nick's laptop stopped
  responding (several seats' gates at once; fifty's PGlite timing runs added to it earlier).

The PGlite leg exists to catch one class of bug: SQL that works on SQLite and fails, or behaves
differently, on Postgres. Every `withDrivers` block lives in `packages/server`. What those tests
execute is `packages/server` and `packages/protocol` source plus the locked dependencies, under the
root test config.

## Problem

A PR that touches none of that closure cannot change what the PGlite leg checks, yet it pays for it
on every run. A seat iterating locally pays for it on a machine everyone shares. The rule was right
about what to check and wrong about who has to check it.

## Decision

1. **CI runs the PGlite leg when the change can reach it.** The `coverage` job picks the drivers
   before it runs the tests. A pull request runs `MUSTERD_TEST_DRIVER=both` when its diff touches
   `packages/server/**`, `packages/protocol/**`, `pnpm-lock.yaml`, `package.json`,
   `vitest.config.ts` or `.github/**`. Any other pull request runs `sqlite`. The step prints
   which it chose and why to the job summary.
2. **A push to `main` always runs `both`.** Every merge is checked on both engines whatever the
   filter decided for its PR, so a closure the filter missed shows up one merge later, not at a
   Cloud deploy.
3. **The local default is `sqlite`.** With `MUSTERD_TEST_DRIVER` unset, `withDrivers` runs on
   SQLite only. A seat changing store or server SQL opts in with `MUSTERD_TEST_DRIVER=both` (or
   `pglite` to reproduce a Postgres-side failure). CI is the authority either way.

Tests that open PGlite directly (`pgliteDriver.test.ts`, `tenancy.test.ts`, the `cloud/` suites)
are not `withDrivers` blocks and keep running under every setting.

## Alternatives rejected

- **PGlite only on `main`.** Cheapest, but a server PR's Postgres-only bug would land and turn
  `main` red for every seat. The filter keeps the check on the PRs that can cause one.
- **Shard `coverage` across more runners.** Cuts wall time, keeps every PR paying the compute, and
  does nothing for the laptop.
- **Keep `both` as the local default and ask seats to set `sqlite`.** It was already documented as
  "the fast loop" in `running-the-gates.md`; the default is what actually runs.

## Consequences

- Docs, web and CLI pull requests no longer run the PGlite half of the server suite. Server,
  protocol and dependency pull requests are unchanged.
- The filter's path list is the claim that `withDrivers` tests reach nothing else. If a
  `withDrivers` test ever lands outside `packages/server`, or server code starts reading another
  package's source, the list has to grow with it.
- The `packages/server` coverage floor (85% lines) now has to hold on a SQLite-only run as well as
  a both-driver one; the PGlite-only lines are mostly in tests that open PGlite directly and still
  run.
- ADR 479 keeps its decision; its Consequences carry a dated note pointing here.
- **2026-10-02 — interim eval reading, day 2 of 7 (fifty, lane `01M3Z1KE11`).** The trace works.
  Every docs, web and CLI PR since #1940 logs `MUSTERD_TEST_DRIVER=sqlite — the PR touches
  nothing the PGlite leg executes`. Every server or protocol PR logs `both` and names its first
  path (#1939, #1942, #1949, #1959). Over 16 filtered PRs (#1943–#1965, without #1938 and #1941,
  which ran the TEMP lines that #1940 removed), the median `coverage` job is **5m05s**
  (3m26s–10m07s), against the 14-min baseline. Two things affect that number, and the final
  reading has to separate them:
  - **#1934 landed 16 minutes before this ADR.** It made the PGlite double 1.4–1.5× faster, so
    both-driver runs got faster too (`main` test step 920s at 20:38Z, then 725–736s that
    evening). Part of the drop against the fixed baseline comes from #1934.
  - **Runner speed changes from day to day.** From about 17:40Z on 2026-10-02 the runners were
    about 2× slower on the same code. The setup step went from 31s to 58s, and #1962 measured
    `lanes.test.ts` at 14.5s, then 44.8s. Filtered PRs that afternoon took 7m31s–10m07s. So the
    final reading compares each filtered PR with a **both-driver `main` run on the same day**,
    not only with the 14-min baseline. Same-day PGlite half of the test step: about 7.5 min on
    10-01 (sqlite PRs 250–300s, `main` 725–736s), about 9 min on 10-02 (534s, 1077–1120s).
  - **Decision 2 checks every merge, but not every run finishes.** `ci.yml` cancels an older run
    on a ref when a newer push arrives (`cancel-in-progress`). Of the last 30 `main` pushes
    (to 2026-10-02 19:27Z), 19 runs were cancelled, 10 passed and 1 was still running. A merge is checked by the next `main` run that finishes, which
    includes it, and that can be several merges later. No `main` run failed in this period, so
    the falsifier has not fired. The final reading is due 2026-10-08.

- 2026-10-03 — [ADR 498](498-sharded-coverage-leaf.md) shards the `coverage` leaf across three
  runners after all. The rejection above was about compute per PR, and that cost stands (about two
  extra setups and a merge per run); the driver scoping here remains the compute lever. What
  changed is the runner: the repo went private on 2026-10-02 and `ubuntu-latest` became 2 vCPU,
  so the leaf ran 25–27 min on every push to `main` — wall time, not compute, became the pain.
- 2026-10-03 — [ADR 499](499-gates-run-where-inputs-changed.md): "a push to `main` always runs
  both" holds whenever the suite runs at all; a docs-only squash runs no suite on either engine,
  because no engine's inputs changed.
- 2026-10-12 — **The compute objection no longer applies.** The repo is public again (ADR 565),
  where GitHub-hosted minutes are free (ADR 569). [ADR 572](572-sqlite-prs-shard-coverage.md) shards
  SQLite-only PR coverage two ways for wall time. The driver scoping above is unchanged.
- 2026-10-14 — **Final eval reading: met (fifty, lane `01M3Z1QPV5`).** The filter decided PR
  drivers by itself only from #1937 (2026-10-01 21:11Z) to ADR 498's sharding (2026-10-03
  04:20Z). After that the `coverage` leaf ran as shards, and from 2026-10-05 ADR 510 replaced the
  filter, so the week the Eval named never ran on one job layout. The reading uses that first
  window: 96 completed `coverage` jobs, the driver line read from each job's log, three TEMP runs
  left out.

  The runners changed speed inside the window, when the repo went private at about 17:40Z on
  2026-10-02. So each group is compared only with runs on the same runners:

  | Runners | PRs on `sqlite` | PRs on `both` | `main` on `both` |
  | --- | --- | --- | --- |
  | before 10-02 17:40Z | 4m58s (17 PRs) | 9m42s (6) | 12m47s (7) |
  | after | 9m39s (28) | 19m46s (28) | 26m09s (6) |

  These are job medians. Against PRs that ran `both` on the same runners, a filtered PR saved
  4m44s and then 10m07s: the PGlite half itself, since the test step alone fell by 4m52s and 9m41s.
  Against the 14-min baseline, the pre-slowdown median of 4m58s is 9 minutes lower. The Pass
  condition, a drop of at least the PGlite half, holds both ways. `main` runs took 3–6 min longer
  than PRs that also ran `both`, so the interim note's pairing with `main` overstates the saving;
  the PR-to-PR figures above are the like-for-like ones.

  The falsifier did not fire. Four `main` runs went red while the filter decided PR drivers
  (to 2026-10-05). None of them failed a test on either engine:
  - a typecheck (2026-10-01);
  - an a11y tap-target sweep (2026-10-03);
  - a `gates` roll-up whose every leaf passed (2026-10-03);
  - `coverage-merge` after all four shards passed (2026-10-04, #2057), whose log has expired.


_Note, 2026-10-05 (izzo, lane 01M46EH1FA)._ **The PR half of the filter is replaced.**
[ADR 510](510-pr-sqlite-only.md) makes every PR run SQLite only, unless it carries the `pglite`
label. Both drivers now run on main's 4-hourly scheduled check ([ADR 508](508-main-push-coverage-cost.md)),
not on every push and not on server-touching PRs. The reason is cost: after ADR 508, PR runs were
most of what was still billed. The path list above no longer decides anything.

## Observability & Evaluation

- **Traces:** the `coverage` job summary names the drivers it chose and the first path that
  triggered `both`, or says the PR touched nothing the PGlite leg executes.
- **Eval:** dataset = `coverage` job durations of docs-only, web-only and CLI-only PRs over the week
  after this lands. Baseline = 14 min (`docs/deck-appendix`, 2026-10-01) and the 14–16 min of every
  PR that day. Pass = their median drops by at least the PGlite half of the server suite.
- **Experiment:** the filter's falsifier. A Postgres-only bug that a filtered PR could have caught
  first goes red on a `main` push. One such case means the path list is wrong: fix the list, not
  the rule.
