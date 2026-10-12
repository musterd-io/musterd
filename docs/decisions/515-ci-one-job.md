# 515 — CI runs as one `gates` job; a draft PR runs nothing until it is ready

- Status: accepted
- Date: 2026-10-05
- Deciders: nick (raised the Actions budget a third time on 2026-10-05: "we really need to improve on
  costs"; chose this over waiting for a self-hosted runner), izzo (owns CI spend)
- Lane: `01M46QW1WHEYWKAGHT8H3Q7YZN`
- Amends: ADR 106 (the 2026-09-03 parallel-leaves amendment), ADR 498 (coverage shards), ADR 499
  (the `plan` job). Keeps: ADR 492/510 (drivers), ADR 508/512 (main's full check)

## Context

ADR 508, 510 and 512 cut what CI runs. Measured over the 2.5 hours after they landed
(2026-10-05 16:46Z–19:13Z, Actions API, each job's wall time rounded up to the minute as billed):
276 billed minutes. At that pace that is about 2,700 a day, or about $21. The pace was a busy
afternoon (19 PR runs), not a daily average.

| Job          | Billed min | Share | What it did                                    |
| ------------ | ---------- | ----- | ---------------------------------------------- |
| coverage     | 93         | 34%   | the tests                                      |
| docs         | 54         | 20%   | setup + build, then format/docs checks (~25 s) |
| static       | 45         | 16%   | setup + build, then typecheck/budgets/lint     |
| plan         | 29         | 11%   | a checkout and a diff (~6 s)                   |
| gates        | 27         | 10%   | a jq check over the others (~6 s)              |
| a11y, other  | 28         | 10%   |                                                |

Two costs that belong to the shape, not to the work, are most of the bill. **Every job pays its
own checkout, install and build** (about 1.2 minutes). **GitHub rounds every job up to a whole
minute**, so `plan` and `gates` bill a minute each for six seconds of work. The parallel-leaf shape
(ADR 106 amendment, ADR 498, ADR 499) was chosen for wall time on a public repository, where minutes
were free.

## Problem

On a billed repository the fan-out multiplies the fixed cost per job. A typical PR run has five
jobs, so it pays five roundings and three setups to do about three minutes of distinct work.

## Decision

1. **One job, `gates`, runs every gate as a step.** It keeps the required check's name, so branch
   protection is unchanged. It runs, in order: the pick (the old `plan` logic, unchanged, as a
   step); one setup and build; typecheck, perf budgets, context budgets, lint; `format:check` and
   `change-adr:check`; tests with coverage; and the five a11y steps. Each step group runs where its
   old leaf ran, decided by the pick's outputs.
   _(Amended 2026-10-12: superseded by [ADR 570](570-ci-fans-out-on-the-public-repo.md) once the
   repo went public. See the amendment below.)_
2. **Coverage is not sharded.** One run enforces the floors itself, as every one-shard run has since
   ADR 498. The both-driver suite now takes about 20 minutes of wall time. It runs only on main's
   full check and on `pglite`-labelled PRs, where wall time matters least.
   _(Amended 2026-10-12: superseded by [ADR 570](570-ci-fans-out-on-the-public-repo.md) once the
   repo went public. See the amendment below.)_
3. **The full-main-check marker is its own artifact, `full-main-check`.** It is uploaded only when a
   full check on main passes. ADR 512's trigger reads it, instead of the coverage shard blob that no
   longer exists. A red full check leaves no marker, so the next push retries it.
4. **A draft PR runs nothing.** `gates` is skipped while `pull_request.draft` is true, and
   `ready_for_review` re-runs it. A skipped required check reads as passing. That is safe only
   because GitHub does not merge a draft, and a draft cannot arm auto-merge.
5. `main-red` (ADR 508) is unchanged, except that it now waits on the one job.

## Consequences

- **Expected saving: about 35–45% of the remaining spend.** For a PR this is one setup instead of
  three and one rounding instead of five: about 6–7 billed minutes against about 10. For a push to
  main it is about 3–4 against about 7. The Eval below decides the real number.
- **Wall time goes up.** The gates no longer run side by side. A SQLite-only PR takes about 7–9
  minutes (it was about 5–6), and about 12–14 when the a11y steps run. A both-driver run takes about
  20–25 minutes.
- **Less is visible at a glance.** The checks list shows one `gates` row, not one row per gate. Open
  the run to see which step failed. The step summary still states which gates ran and why.
- **The first push after this lands runs a full check**, because no `full-main-check` artifact
  exists yet. That costs one both-driver run.
- `package.json`'s `coverage:merge` script and `vitest.config.ts`'s `MUSTERD_COVERAGE_SHARD` branch
  are now unused by CI. They are left in place, harmless, for a future runner where sharding is free.
- **A flaky step now costs a re-run of the whole job, not of one leaf.** The first known flake is
  fixed in this change. The connected `/board` tap-target sweep measured the nav shell before the
  goal grid mounted, which happened twice on 2026-10-05. `target-size-sweep.mjs` now keeps polling
  until a required surface is present, up to its existing 20 s cap.
- When a self-hosted runner lands, minutes stop being billed. Then re-weigh this ADR against wall
  time. Fanning back out would be a deliberate choice, not a revert.

_Note, 2026-10-05 (izzo, from miley's report)._ **Item 4 was wrong, and [ADR 523](523-drafts-run-ci.md)
reverses it.** A skipped required check counts as passing. #2104 went draft → ready → auto-merge
and landed on its draft run's `gates: skipped` before the `ready_for_review` run existed. Drafts run
CI again, and `gates` carries no job-level skip.

_Note, 2026-10-12 (izzo, nick's call)._ **Items 1 and 2 are superseded by [ADR 570](570-ci-fans-out-on-the-public-repo.md).**
The repo went public ([ADR 565](565-repo-public-musterd-io.md)), so minutes are free and the billed
setup per job that this ADR saved is gone. The gates run as parallel jobs again, and the both-driver
suite shards four ways with `coverage-merge`. Item 3 (the `full-main-check` artifact) stands; the
`gates` fan-in uploads it now.

## Observability & Evaluation

- **Traces:** none new. The pick step prints and summarises the plan line, and each skipped step
  shows grey in the run.
- **Eval:** billed minutes per run kind (PR / push to main / full check), computed as in the Context
  section, over the first 30 runs after merge. Baseline from the Context window: about 9.3 billed
  minutes per PR run and about 5.6 per push to main. Pass: a PR median of 7 or less, and a
  push-to-main median of 4 or less.
- **Experiment:** none designed. If the PR median does not fall by at least 25%, the per-job model
  above is wrong. Re-measure the setup cost before trying anything else.
