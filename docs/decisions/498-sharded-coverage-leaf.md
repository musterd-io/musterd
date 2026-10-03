# 498 — The coverage leaf runs as three shards; the floors are enforced on the merged report

- Status: proposed
- Date: 2026-10-03
- Deciders: izzo (nick asked for CI time to come down on 2026-10-03 and said to take the most
  effective option)
- Lane: `01M3ZRD2N7PY2PTK123GTJP5YX`; builds on big-body's `01M3ZC1Z6GAJ8Z58DJWXDK0JPW` (#1985)
- Relates to: ADR 106 (the gates and their fan-out), ADR 492 (the PGlite leg runs where it can
  catch something — which rejected sharding), ADR 479 §3 (the store suite on both drivers)

## Context

The repository went private on 2026-10-02. GitHub's `ubuntu-latest` runner is 4 vCPU for public
repositories and 2 vCPU for private ones, and CI's `coverage` leaf — the whole vitest suite under
`pnpm coverage` — is CPU-bound: 11,491 tests across 680 files, ~2,470 file-seconds of work when
both store drivers run. On the 2-vCPU runner it took 25–27 minutes on every push to `main` and on
every pull request that touches server or protocol code (6–10 minutes when ADR 492 picks SQLite
only), while every other leaf finished in under 4 minutes. big-body measured two workers against
four the same day (#1985): 25m50s–26m became 18m27s–23m21s, and two workers became the default.
Measured on runs 37085242981, 37081701427 and 37084809904 (2026-10-03): one file,
`packages/server/src/transport/integration.test.ts`, is 450–630 s of that work by itself (692
tests on both drivers; 50 s on SQLite alone); the PGlite leg is roughly 85% of the file-seconds.

ADR 492 listed "shard `coverage` across more runners" under rejected alternatives: it cuts wall
time, keeps every PR paying the compute, and does nothing for the laptop. Its chosen lever — run
the PGlite leg only where a change can reach it — cut compute. The repo now runs 100–166 CI runs a
day; wall time is what every seat waits on before a squash-merge.

## Problem

The leaf's wall time is bounded by CPU on a 2-vCPU machine. Fewer workers were already tried; more
workers were measured slower. The only levers left are more machines, less work per run, or
weaker gates. The last is not on the table.

## Decision

1. **A `plan` job picks the drivers and the shard count; the `coverage` leaf is a matrix over
   it.** The ADR 492 pick is unchanged and moves into `plan` (a checkout and a diff, ~20 s). When
   both drivers run — every push to `main`, PRs that touch server or protocol — there are three
   shards, each
   `pnpm coverage --maxWorkers=2 --shard=<i>/3 --reporter=default --reporter=github-actions --reporter=blob`;
   when SQLite alone runs there is one shard and no merge, exactly the job it always was. vitest's
   `--shard` sorts files by a hash of their path and slices contiguous chunks, so the split is
   stable across runs and machines.
2. **The floors are checked once, on the merged report.** A shard's coverage map is partial by
   construction, and vitest checks `coverage.thresholds` at the end of every run — so each shard
   would fail on its own map. `vitest.config.ts` omits `thresholds` when `MUSTERD_COVERAGE_SHARD`
   is set (the shards of a sharded run set it; a one-shard run leaves it empty and enforces the
   floors itself); a new `coverage-merge` job downloads the blobs, refuses unless every shard's is
   present, and runs `pnpm coverage:merge` (`vitest run --merge-reports --coverage`), which replays
   the test results, merges the maps and enforces the per-package floors on the whole.
   `pnpm coverage` without the variable still enforces them locally, unchanged.
3. **The merge installs but does not build.** The blobs already carry source-mapped coverage; the
   job needs `node_modules` (the coverage provider) and the same checkout path as the shards (the
   floors are glob-matched against root-relative paths). `.github/actions/setup` gains a
   `build: 'false'` input for it.
4. **Blobs are 1-day artifacts; the artifact actions are pinned by commit SHA**, not by tag
   (`actions/upload-artifact@043fb46d…` v7.0.1, `actions/download-artifact@3e5f45b2…` v8.0.1). A
   tag can be moved; a commit cannot. Workflow permissions stay `contents: read`.
5. **`gates` fans in on `plan`, the shards and the merge.** Its rule is unchanged but for one
   sanctioned skip: `coverage-merge` may be skipped when `plan` chose one shard; every other skipped
   or cancelled job is red.
6. **Three shards, not more, until `integration.test.ts` is split.** The shard that holds that file
   runs it on one worker for ~10 minutes; more shards would not shorten it and would cost a setup
   each. ADR 492's scoping stays as the compute lever.

Weighed and rejected: larger GitHub-hosted runners (4+ vCPU) — a billing decision for the org
admin, not a change a seat can land; worth revisiting with the minutes bill in hand. Splitting
`integration.test.ts` first — correct and mechanical (11,234 lines, 36 describe blocks, helpers
that close over the wrapper's `server`/`base`/`wsUrl`), but on 2 vCPU the leaf is bound by total
work, so splitting alone would not have moved the wall time; lane `01M3ZRPWDBJJVZTD76DVRE08WX`
splits it, which is what lets the shard count rise. Making the PGlite leg cheaper per test (the 44-table `TRUNCATE … RESTART IDENTITY
CASCADE` on every open, the second daemon boots) — the real compute lever, measurement first:
lane `01M3ZRQAGDDMTG6TA9T27D02N9`.

## Consequences

- Expected wall time, from the measured file-seconds: both-driver runs ~14 minutes (the
  `integration.test.ts` shard ≈ 10.5 min of tests + ~2.5 min setup, then ~1 min of merge) instead
  of 25–27; SQLite-only pull requests are unchanged (one shard, no merge). Measured on this ADR's
  own PR run (37089527734, attempt 2, 2026-10-03, both drivers): shards 12.3 / 8.2 / 5.8 minutes
  wall including setup (vitest 674 / 422 / 298 s; 4,309 + 3,559 + 3,598 = 11,466 tests passed) —
  the whole run would have closed at ~13 minutes plus the merge, against 26.1 and 26.7 on the two
  `main` runs before it.
- Compute rises by about two setups and one merge, ~6.5 runner-minutes, on both-driver runs only;
  SQLite-only pull requests — most of the 100–166 runs a day — pay the ~20 s `plan` job and
  nothing else. The org's Actions minutes are billed on a private repository: on 2026-10-03 GitHub
  refused to start every job over the org's spending limit or a failed payment, which is the bill
  making itself felt. The admin reads it (the seat token lacks the scope); the follow-up lanes below
  are the compute levers.
- The coverage floors are enforced exactly once per run, by `coverage-merge`. A shard that ran
  without `--coverage`, or a merge run from a different root path, would make the floors pass
  vacuously — the merge step therefore refuses unless exactly three blobs are present, and the
  merged per-package percentages are compared against the last unsharded run on this PR.
- `coverage-blobs/` (the blobs' home — vitest's default `.vitest-reports/` is a hidden path, which `upload-artifact` skips by default; the first run of this job uploaded nothing) is ignored by git. `MAX_WORKERS = 4` in `vitest.shared.ts` is the laptop's
  number; CI passes `--maxWorkers=2` explicitly, as before.
- Follow-ups, each with its lane: split `integration.test.ts` along its depth-1 describes behind an
  `integrationHarness(kind)` factory, then raise the shard count — lane `01M3ZRPWDBJJVZTD76DVRE08WX`;
  measure and cut the PGlite leg's per-test cost — lane `01M3ZRQAGDDMTG6TA9T27D02N9`.

- 2026-10-03, measured after landing: the first both-driver run after #2007 closed in 12.3 min
  (shards 11.7 / 8.5 / 8.3, merge 0.4) against 26.1 and 26.7 before; merged coverage 87.39% lines
  against 87.37% unsharded; 11,494 tests. #2010 (ADR 499) ran 12.5 min and #2012 (in-memory SQLite
  opens clone one migrated database, `docs/perf/test-open-cost.md`) 12.1 min with −229 s of vitest `tests` time
  against the run before it. The shard holding `integration.test.ts` is the long pole at ~12 min,
  as Decision 6 says; lane `01M3ZRPWDBJJVZTD76DVRE08WX` is what moves it.

- 2026-10-03, Decision 6's condition met: lane `01M3ZRPWDBJJVZTD76DVRE08WX` split
  `integration.test.ts` into eight `transport/integration.*.test.ts` files along its depth-1
  describes, over one shared `integration.helpers.ts` (`integrationHarness(kind)`), and `plan` now
  picks four shards on a both-driver run. Same 322 tests. The arithmetic: the three shards summed
  ~23 runner-minutes on `e088a57e` (12.1 / 5.8 / 5.1), ~7.5 of it setup, so four even shards are
  ~4 min of tests + ~2.5 min setup each, at one more setup (~2.5 runner-minutes) per both-driver
  run. Measured on the lane's own PR run (37138677668, both drivers, 2026-10-03): shards 5.0 /
  7.9 / 6.2 / 6.4 min wall including setup (vitest 243 / 403 / 308 / 323 s) against 12.1 / 5.8 /
  5.1 at three on `e088a57e` — the long pole 12.1 → 7.9 min, the run 8.2 min before the merge;
  25.5 runner-minutes of shards against 23.0. The path hash still lands unevenly (shard 2's vitest
  403 s against shard 1's 243 s); a fifth shard would buy ~1.5 min for another setup.

- 2026-10-03, measured on #2020's green head (run 37140146939, `2bd8d1be`, both drivers): shards
  6.2 / 5.6 / 6.7 / 6.2 min wall including setup, merge 0.5 min, the run 7.5 min end to end —
  against 12.3 on #2007's first three-shard run and 26.1 / 26.7 unsharded. 24.7 runner-minutes of
  shards. The four shards are now within 1.1 min of each other; the long pole is 6.7 min. Not yet
  measured: a full-suite `main` run on the split — the post-merge runs for `9ce68b52` and
  `2004a04b` were cancelled by newer commits, and `5efab05c` was docs-only. The ≤ 15 min target
  above is judged on that run when it comes.

## Observability & Evaluation

**Traces.** No new trace event. GitHub's run and job timings are the record:
`gh run view <id> --json jobs` gives each shard's and the merge's duration; the merge job's log
carries the merged `text-summary` and the floor verdicts.

**Eval.** Dataset: push-to-main CI runs (always both drivers) and pull-request runs, before and
after this lands. Baseline (2026-10-03, two workers, one leaf): `main` runs 37085242981 (26.1 min)
and 37083161919 (26.7 min); both-driver PR runs 15.6–25.8 min; SQLite-only PR runs 6.4–10.5 min.
Target: the first five `main` runs after landing ≤ 15 min wall; SQLite-only PRs ≤ 6 min; the
merged per-package line percentages within 0.5 points of the last unsharded `main` run (the
`text-summary` of 37085242981).

**Experiment.** n/a — a before/after on the same suite; the shard count is the one knob, and
Decision 6 says when to turn it.

Falsifier: a both-driver `main` run above 20 minutes after landing (the arithmetic was wrong); a
merged floor that passes while an unsharded `pnpm coverage` on the same commit fails (the merge is
not enforcing what the leaf enforced); or a shard count raised before `integration.test.ts` is split
that does not lower the wall time.
