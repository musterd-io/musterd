# 523 — Draft PRs run CI; `gates` never carries a job-level skip

- Status: accepted
- Date: 2026-10-05
- Deciders: izzo (owns CI; the defect is ADR 515's), found by miley
- Lane: `01M475HWEM0B6KBBCVPXBFZZX4`
- Supersedes: ADR 515 Decision item 4 ("a draft PR runs nothing until it is ready")

## Context

ADR 515 gave `gates` the job-level condition
`if: github.event_name != 'pull_request' || !github.event.pull_request.draft`, so a draft PR's
run ended with `gates: skipped`. The ADR called this safe "because GitHub does not merge a
draft". On 2026-10-05, miley opened #2104 as a draft, ran `gh pr ready` and then
`gh pr merge --squash --auto`, and the PR merged at 21:13:41Z. At that moment its only checks were
the draft run's `gates: SKIPPED` and `main-red: SKIPPED`. **Branch protection counts a skipped
required check as passing.** The `ready_for_review` run had not been created yet, so nothing
pending blocked the merge. #2104's later `gates` run passed and main stayed green, so nothing bad
landed. The rule was still broken for every PR that took the same path.

## Problem

A required check that can end as `skipped` is not a gate. Any job-level condition on `gates` that
evaluates false on a PR event produces exactly that.

## Decision

1. **Remove the draft condition. Draft PRs run `gates` like any other PR.**
2. **Drop `ready_for_review` from the triggers.** The draft's head SHA was already tested, so
   marking it ready would re-test the same commit.
3. **The rule, written into the workflow comment:** `gates` gets no job-level `if:` that can skip it
   on a PR. Work that should not run goes in step-level conditions inside the job. The job always
   ends `success` or `failure`.

## Consequences

- Drafts cost CI again. Drafts were about 10% of runs on 2026-10-05, roughly $2 a month on Ubicloud
  (ADR 517).
- The scheduled-run skip (ADR 512: main unmoved since the last full check) is already step-level.
  The job runs, skips its steps and succeeds, so it does not carry the same hole.
- ADR 515's other decisions (one job, unsharded coverage, the `full-main-check` marker) stand.

## Observability & Evaluation

- **Traces:** none new.
- **Eval:** no PR merges with a `gates` conclusion other than `success`. To check: list merged PRs
  since this change, read each one's `gates` check-run conclusion, and expect zero `skipped` or
  `neutral`.
- **Experiment:** none. The falsifier is a merged PR whose only `gates` check is `skipped`.
