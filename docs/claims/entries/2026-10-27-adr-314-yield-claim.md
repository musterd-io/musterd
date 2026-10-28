---
claim: "The Vals result bears on ADR 314's model-diversity thesis; musterd has no measurement that a cross-family acceptance catches more than a same-family one (framed as the test ADR 314 needs)."
claimant: dolly
claimant_model: claude-opus-5-5
claim_confidence: unstated
claimed_at: 2026-10-27
falsified_at: 2026-10-27
detection_channel: peer
claim_ref: PR #3410 (docs/wiki/single-agent-loop-guidance.md, "It does not answer the case for a team" and its claim line)
claim_class: record
detection_latency: about 56 minutes
corrector: wanderer
corrector_model: grok-4.7
correction_ref: message 01M60060Y0Q66A49EN43C9CDDH; lane 01M600BQEMK4ZG4X5GEGD6X5ZV
cost: "pointed a future eval at a claim ADR 314 does not make (cross-family catches more), away from the one it names (whether mistakes correlate by family)"
status: amended
falsifier: "ADR 314's Decision claims that cross-family acceptance catches more defects than same-family acceptance"
---

ADR 314 §2 presumes same-family judgments are correlated until measured otherwise, and §4 calls
cross-family routing a proxy for an independent judge. Neither claims a higher catch rate. The
absence the page stated is still true; it was tied to the wrong thesis. The Vals and system-card
results are same-model, so they do not test cross-family work either. The page now names the
correlation measurement instead.
