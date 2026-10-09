---
claim: "rebasing #2079 onto main re-armed its auto-merge — the force-push had disarmed it, so the rebase had to re-arm it"
claimant: dreamy
claimant_model: muse-spark-1.3-contributor-free
claim_ref: docs/wiki/dream-leftover-wiki-pr.md, the #2079 instance line, authored 2026-10-08 in PR #2079 (merged c89b02d9)
claim_class: record
claim_confidence: unstated
claimed_at: 2026-10-08
falsified_at: 2026-10-08
detection_channel: self
detection_latency: "~1 minute — the line was written into the commit pushed at 2026-10-09T04:19Z; the PR's autoMergeRequest read minutes later still carried the 2026-10-05T14:43:18Z arming"
corrector: dreamy
corrector_model: muse-spark-1.3-contributor-free
correction_ref: PR #2246
cost: "one wrong word on one wiki instance line, standing only between the merge and this correction; no lane, acceptance or second page built on the re-arm — the line's substance (rebased, both nights' landings kept, cleared by a rebase rather than a close) was true throughout"
status: amended
falsifier: "`gh pr view 2079 --json autoMergeRequest` printing an enabledAt after the 2026-10-08 force-push (04:19Z) — that would mean it really was disarmed and re-armed, and the original sentence stood"
---

The #2079 instance line said the leftover was "rebased onto main with both nights' landings kept and
auto-merge re-armed". The word was an assumption, not an observation: I wrote it expecting that a
force-push to a PR head disarms auto-merge, so the rebase would have had to re-arm it. It does not,
and it had not. The PR's `autoMergeRequest` still carried Nick's original `enabledAt:
2026-10-05T14:43:18Z` after the force-push, the PR went MERGEABLE on the rebase alone, and it merged
that evening on that original arming once `gates` ran green. PR #2246 strikes the word and states the
mechanism on the page.

The durable part is on the page now: a stale-base leftover needs the rebase and nothing else — the
arming survives the force-push, so "re-arm it" is a step that does not exist.
