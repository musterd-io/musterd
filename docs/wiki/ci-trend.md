# CI trend

What CI's shape has been week over week on revive — main wall-clock p50/p90, `main-red` count, PR flake rate and per-job p50s — as `musterd report ci` reads it (ADR 610), and the caveats on reading it.

## How the numbers are made (2026-10-15)

`musterd ci sample` reads completed `ci.yml` runs off GitHub through `gh` and posts them as `ci.run_measured` rows; the ci-probe LaunchAgent runs it hourly as the `autorefresh` service seat after it dispatches the probe (`scripts/ci/main-probe.sh`). `deriveCiTrend` buckets rows by the run's own creation time into the last 7 days and the 7 before. A run is "main" when its branch is `main` and its event is not `pull_request`; `main-red` is such a run concluding `failure`; a PR head SHA is "flaky" when a run on it failed and a later run on the same SHA passed, or a passing run carries `attempt > 1`. Cancelled runs are neither red nor green.

**The first sample is shallow (2026-10-15; falsify: `musterd report ci --json` showing `previous.main_runs > 0` before 2026-10-22).** `gh run list` caps at 200 runs, which on 2026-10-15 reached back about two days. Until the hourly tick has accumulated a fortnight, the "previous" window is empty and the arrows in `musterd report` are blank. Every weekly entry below says which window it covers. <!-- claim: other -->

## Weekly readings

Numbers are what `musterd report ci` printed; "window" is the span the rows actually cover, not the nominal 7 days.

| read on | window covered | main runs | p50 | p90 | main-red | PR SHAs | flaky | slowest job p50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 2026-10-15 19:55Z | 2026-10-13 → 10-15 (first sample, 197 runs) | 88 | 1.9m | 2.6m | 2 | 109 | 1 (0.9%) | coverage (4) 4.3m on 3 runs; coverage (2) 2.7m on 62 |
| 2026-10-21 00:40Z | 2026-10-12 → 10-19 15:50Z (sampler stopped; see below) | 409 | 1.9m | 3.1m | 26 | 447 | 6 (1.3%) | coverage (4) 4.7m on 33 runs; coverage (2) 2.8m on 297 |

**What the first reading says.** Main is fast and green: p50 under two minutes and p90 under three, with the two reds being the scheduled full checks that opened `ci: main is red` issues (ADR 508). The flake rate is one SHA in 109. The slowest regular job is a coverage shard at 2.7 minutes; `coverage (4)` only exists on the 4-hourly full check (ADR 570's both-driver shard), which is why it has three runs. `docs` is the job that runs most (169 of 197 runs) and takes 1.4 minutes, so a docs-only PR's wall clock is the docs job plus `plan`.

**What to look for next week.** A p90 that moves more than 10% without a CI workflow change; a flake count above 2 (ADR 610's arrow turns ↑); any `main-red` that is not a scheduled full check — a `push` run on main going red means `gates` on the PR missed something.

**What the second reading says (2026-10-21).** p50 held at 1.9m, but p90 moved from 2.6m to 3.1m (+19%), past the 10% line set above, and nothing here pins it to one workflow change. The flaky count, 6, is also past the line of 2. And `main-red` is no longer only the scheduled full check. `gh run list` for main over the same week counts 19 failed `push` runs, 27 failed `workflow_dispatch` runs (the probe) and 2 failed `schedule` runs, so pushes to main did go red. Part of that is the 2026-10-20 stale-controls break (#3080: four controls crossed their staleness bounds and every run failed `controls:check` until they were exercised); the rest is not yet sorted by cause. The "previous" window still reads 0 runs, which is consistent with the shallow first sample above. Separately, the sampler stopped: its newest row is 2026-10-19 15:50Z, a day before this reading. A direct `gh` read of 58 runs from 2026-10-20 20:57Z to 10-21 00:37Z gave main p50 2.6m / p90 3.2m and PR p50 4.8m / p90 6.3m.

## Related

- [running the gates](running-the-gates.md) — what the jobs are and the order they run in.
- [ci not running](ci-not-running.md) — when the probe or the cron stops dispatching.
- ADR 610 — the instrument; ADR 508 — `main-red`; ADR 542 — the ci-probe LaunchAgent.
