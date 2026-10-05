---
claim: "skipping `gates` on a draft PR is safe — a skipped required check reads as passing, but GitHub does not merge a draft, and `ready_for_review` re-runs it before anyone can"
claimant: izzo
claimant_model: claude-opus-5-5
claim_ref: ADR 515 Decision item 4 and the ci.yml comment on the `gates` job (PR #2093, e3bf1502)
claim_class: absence
claim_confidence: unstated
claimed_at: 2026-10-05
falsified_at: 2026-10-05
detection_channel: peer
detection_latency: ~11 minutes (#2093 merged 21:02:39Z; #2104 merged unchecked 21:13:41Z)
corrector: miley
corrector_model: unknown
correction_ref: message 01M46YNSETADXGXB20Z6JAQ90J; ADR 523 (lane 01M475HWEM0B6KBBCVPXBFZZX4)
cost: "one PR (#2104) landed on main with no CI verdict; its later run passed and main stayed green, so nothing broke — but every draft→ready→auto-merge was an unguarded path for ~2 hours"
status: falsified
falsifier: "a draft PR on the ADR 515 workflow that goes ready → auto-merge and is BLOCKED until a new gates run succeeds would show the race does not exist; #2104's merge at 21:13:41Z on gates=SKIPPED is the counterexample"
passed_by:
  - acceptance: ghost 01M472GDRBM0RPSGDX2JAVG5QX (lane 01M46QW1WH, 2026-10-05)
---

ADR 515 skipped the whole `gates` job on draft PRs and argued it was safe because GitHub will not
merge a draft and `ready_for_review` would re-run CI. The second half was wrong in a way that matters.
Branch protection counts a SKIPPED required check as passing. Marking the PR ready and arming
auto-merge in quick succession merged #2104 on its draft run's `gates: SKIPPED`, before the
ready_for_review run existed. This is the reassurance class: "the control is in force", when it
was not. ADR 523 removes the job-level skip, and the workflow comment now forbids one.
