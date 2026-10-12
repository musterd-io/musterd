# ADR 569: CI's `gates` job goes back to GitHub-hosted runners now the repo is public

- Status: accepted (2026-10-12, nick, in chat: "yes, take it")
- Date: 2026-10-12
- Deciders: nick, izzo (owns CI spend)
- Lane: `01M4S215MYX8QJ7093M09SKJQB`, goal `ci-cost`
- Supersedes: [ADR 517](517-ci-on-ubicloud.md) decision 1. ADR 517 decisions 2–4 stand.
- Relates to: [ADR 565](565-repo-public-musterd-io.md) (the repo went public), ADR 498 and #1985
  (two vitest workers on 2 vCPU)

## Context

ADR 517 moved `gates` to `ubicloud-standard-2` on 2026-10-05 for two reasons. The first was price:
the repo was private, GitHub-hosted runners were billed at $0.006 a minute, and CI cost about $115 a
month against about $21 on Ubicloud. The second was that GitHub's runner assignment failed for
hours that day.

On 2026-10-12 the repo went public again (ADR 565). GitHub's runner reference, read the same day,
says: "Use of the standard GitHub-hosted runners is free and unlimited on public repositories." The
standard Linux runner for a public repo has 4 CPUs, 16 GB of RAM and a 14 GB SSD. For a private
repo it has 2 CPUs and 8 GB.

The Ubicloud app was installed on `musterd-io` after the transfer, and `gates` was running there on
2026-10-12 (runner `grx798r2…`, label `ubicloud-standard-2`).

## Problem

We pay per minute for a 2-CPU runner when a 4-CPU runner is free. On a public repo, a stranger's
fork PR would also run `gates` on the paid runner once a maintainer approves it.

## Decision

1. **`gates` runs on `ubuntu-latest`.** It is free on a public repo and has twice the CPUs and RAM
   of `ubicloud-standard-2`.
2. **The coverage step runs four vitest workers**, up from two. The two-worker setting (#1985) was
   sized to the 2-CPU runner.
3. **Ubicloud stays the outage fallback.** Its labels stay in `.github/actionlint.yaml`. If GitHub's
   runner assignment fails for long, set `runs-on: ubicloud-standard-2` again. That is one line, and
   it is not automatic. On a 2-CPU runner, set the workers back to 2 as well.
4. **nick decides the Ubicloud account** — pause it, or keep it installed for the fallback. With no
   job asking for its labels it runs nothing, so it should bill nothing beyond any fixed fee.
5. **If the repo goes private again, this ADR's premise is gone.** Re-weigh then, starting from ADR
   517's numbers.

## Consequences

- CI spend for `gates` drops to $0. ADR 517's monthly eval, which compared Ubicloud's bill to its
  projection, ends.
- Runner availability depends on GitHub again. That is the failure ADR 517 saw on 2026-10-05.
  Decision 3 is the documented way out.
- The job's credential is unchanged: the run's own GitHub token, `contents: read` and
  `actions: read`.
- The comments in `ci.yml` that describe the private-repo, 2-CPU world (the header's sharding
  history, the coverage step) are history, not current guidance. The coverage step's comment now
  names this ADR.

## Observability & Evaluation

- **Traces:** none new. The run's job page shows the runner's label and name.
- **Eval:** the first full `gates` run on `ubuntu-latest` (both drivers, on main) should log 4 CPUs
  (`nproc` in the "Runner" step) and pass. Then, over the first week, compare its median wall time
  to the median of the same run kinds on Ubicloud in the week before. Pass: no slower. If it is
  slower, the four workers are the first suspect: try three.
- **Experiment:** none.
