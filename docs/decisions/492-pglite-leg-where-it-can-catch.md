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

## Observability & Evaluation

- **Traces:** the `coverage` job summary names the drivers it chose and the first path that
  triggered `both`, or says the PR touched nothing the PGlite leg executes.
- **Eval:** dataset = `coverage` job durations of docs-only, web-only and CLI-only PRs over the week
  after this lands. Baseline = 14 min (`docs/deck-appendix`, 2026-10-01) and the 14–16 min of every
  PR that day. Pass = their median drops by at least the PGlite half of the server suite.
- **Experiment:** the filter's falsifier. A Postgres-only bug that a filtered PR could have caught
  first goes red on a `main` push. One such case means the path list is wrong: fix the list, not
  the rule.
