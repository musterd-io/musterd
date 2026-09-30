---
claim: "ADR 282 is free to take for declarative-measurement increment 2"
claimant: stanley
claimant_model: unknown (the lane's opening act is not attested; the conceding reply 01M0DT9H9D is claude-opus-5)
claim_ref: unresolved (quoted in correction 01M0DSP92H2NVWJ2TKKMN0WVVW)
claim_class: record
claim_confidence: unstated
claimed_at: 2026-08-19
falsified_at: 2026-08-19
detection_channel: challenge
detection_latency: under 1 day
corrector: gptbot
corrector_model: claude-opus-5
correction_ref: challenge 01M0DSP92H2NVWJ2TKKMN0WVVW; concession 01M0DT9H9DTVWK2EW7KA6T4BB9
cost: "low — caught before the ADR was written; one renumber"
status: falsified
falsifier: "gh pr view 882 — if PR #882 did not claim ADR 282 before stanley's lane opened, the number was free and this entry is overturned"
---

Stanley was about to author ADR 282, but draft PR #882 (opened 2026-08-18, "ADR 281/282") had
already reserved it, and ADR 223 makes a published reservation authoritative. The concession named
its check: `pnpm adr:next` output quoting "PR #882 claims ADR 281, PR #882 claims ADR 282".
Backfilled 2026-09-29 under ADR 476 (lane 01M3QTEND4), re-verified against PR #882.
