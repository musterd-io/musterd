# ADR 570: CI fans out again on the public repo

- Status: accepted (2026-10-12, nick, in chat: "yes, take 1 and 2")
- Date: 2026-10-12
- Deciders: nick, izzo (owns CI spend)
- Lane: `01M4S34XXCCES8QRTM9ZK7T05M`, goal `ci-cost`
- Supersedes: [ADR 515](515-ci-one-job.md) decisions 1 and 2. ADR 515 decision 3 (the
  `full-main-check` artifact) stands; decision 4 was already reversed by ADR 523.
- Relates to: [ADR 565](565-repo-public-musterd-io.md) (the repo is public),
  [ADR 569](569-ci-on-github-hosted-public.md) (free 4-CPU GitHub-hosted runners), ADR 498 (coverage
  shards and the merge), ADR 106 (the 2026-09-03 parallel-leaves amendment)

## Context

ADR 515 put every gate into one `gates` job on 2026-10-05. Its Context says why: on a billed
repository, every job paid its own checkout, install and build, and GitHub rounded each job up to a
whole minute. It also says the parallel shape before it "was chosen for wall time on a public
repository, where minutes were free."

The repo is public again (ADR 565), and since ADR 569 `gates` runs on GitHub's standard runner,
which is free on a public repo and has 4 CPUs. The first run on it (run 38314459540, #2404,
2026-10-12) took 605 s, all of it serial:

| Steps                                   | Time    |
| --------------------------------------- | ------- |
| Tests + coverage (SQLite, 4 workers)    | 221 s   |
| Five a11y steps                         | ~270 s  |
| Typecheck, budgets, lint, format + docs | ~82 s   |
| Setup and build                         | 32 s    |

The both-driver suite, which runs on main's full check and on `pglite`-labelled PRs, took about 20
minutes unsharded on the 2-CPU runner (ADR 515 decision 2).

## Problem

A PR waits for the sum of the gates when nothing makes it wait for more than the longest one, and
main's full check waits about 20 minutes for a suite that can be split. The cost that justified
this is gone.

## Decision

1. **The gates run as parallel jobs again**: `plan` (the pick, unchanged, plus the shard count),
   then `static`, `docs`, `coverage`, `a11y-prerender` and `a11y-connected` in parallel, each with
   its own checkout and setup. `gates` needs them all, runs with `if: always()`, and fails unless
   each one succeeded or was skipped for a reason `plan` gave. It stays the one required check and
   never carries an `if:` that can skip it (ADR 523).
2. **When both drivers run, coverage runs as four shards plus `coverage-merge`**, which merges the
   blobs and checks the floors on the merged map, as in ADR 498. When SQLite alone runs (most PRs),
   coverage is one job and checks the floors itself. Each shard runs four vitest workers.
3. **The full-main-check markers keep their meaning.** `plan` uploads the in-flight marker when a
   full check starts. `gates` uploads `full-main-check` only when every job of that check passed.
4. **The Ubicloud fallback (ADR 569) covers every job.** Going back means changing every
   `runs-on` together, and on a 2-CPU runner setting the workers to 2.

## Consequences

- A full PR run should take about as long as its longest job plus one setup: about 5 minutes when
  the a11y jobs run, about 4.5 when they do not, against 10 and 7 serially.
- Each run pays more runner time: one checkout and setup per job (about 30 s each), and five
  more for a sharded run. On a public repo that costs nothing. If the repo goes private again, ADR
  515's reasoning applies again; re-weigh then.
- A failed job no longer stops the others, so a red PR shows every failing gate in one run.
- `docs/wiki/running-the-gates.md` and the `ci.yml` header describe this shape.

## Observability & Evaluation

- **Traces:** none new. Each job's wall time is on its run page and in the Actions API.
- **Eval:** after a week, compare the median wall time of `gates` runs on PRs that ran tests
  against the serial baseline (605 s with a11y, about 400 s without). Pass: a median under 6
  minutes with a11y. Do the same for main's full check, against about 20 minutes. Pass: under 8.
- **Experiment:** none. If a shard finishes much later than the others, rebalance the shards
  before adding more.
