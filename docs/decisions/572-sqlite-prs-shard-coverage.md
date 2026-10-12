# ADR 572: SQLite-only PRs run coverage as two shards

- Status: accepted (2026-10-12, nick, in chat: "yes")
- Date: 2026-10-12
- Deciders: nick, izzo (owns CI spend)
- Lane: `01M4S70CGA8D2NYQT8GHXGB1RY`, goal `ci-cost`
- Amends: [ADR 570](570-ci-fans-out-on-the-public-repo.md) decision 2, which left SQLite-only
  coverage as one job. Relates to [ADR 492](492-pglite-leg-where-it-can-catch.md), which rejected
  sharding for its compute per PR, and ADR 498 (the shards and the merge).

## Context

Since ADR 570 the gates run as parallel jobs, and #2424 cut the prerendered a11y job from 226 s to
145 s. On a PR that runs SQLite only, which is most PRs, the single `coverage` job is now the
longest job by far. It took 331, 338 and 335 s on the last three such PR runs (2026-10-12), setup
included. Every other job finished in under 150 s.

ADR 492 rejected sharding coverage because every PR would pay the extra compute: about one more
setup and a merge job per run. On the public repo that compute is free (ADR 569). ADR 570 brought
back the shard and merge jobs, so splitting the SQLite run needs only a different shard count.

## Problem

A typical PR waits about 5.5 minutes, nearly all of it on one job that can be split.

## Decision

1. **When SQLite alone runs, coverage runs as two shards**, each with four vitest workers, followed
   by `coverage-merge`, which checks the floors on the merged report. Both-driver runs keep four
   shards (ADR 570).
2. A one-shard run still checks the floors itself, as before. Nothing in the workflow produces one
   now, but the path is kept for the Ubicloud fallback or a manual change.

## Consequences

- Expected PR wall time: about 3.5–4 minutes. Each shard should take roughly 200 s including setup,
  then about 30 s for the merge, so coverage stays roughly even with `a11y-prerender` (145 s) and
  `static` (~120 s).
- Each SQLite-only PR now pays one more setup (~40 s) and a merge job (~30 s) of runner time. That
  is free on the public repo. If the repo goes private again, this is the first thing to undo.
- The merge job now runs on almost every PR, so a missing or broken shard blob shows up on PRs, not
  only on `main`'s full check.

## Observability & Evaluation

- **Traces:** none new. Job times are on each run's page and in the Actions API.
- **Eval:** after a week, compare the median wall time of SQLite-only PR runs that ran tests against
  the ~5.5 min baseline above. Pass: a median under 4.5 minutes. If the two shards differ by more
  than a minute, rebalance them before adding a third.
- **Experiment:** none.
