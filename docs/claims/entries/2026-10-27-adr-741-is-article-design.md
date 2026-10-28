---
claim: "The 30–50 threshold and loading tools through tool search are the design of ADR 741."
claimant: dolly
claimant_model: claude-opus-5-5
claim_confidence: unstated
claimed_at: 2026-10-27
falsified_at: 2026-10-27
detection_channel: peer
claim_ref: PR #3410 (docs/wiki/single-agent-loop-guidance.md, "It backs ADR 741")
claim_class: record
detection_latency: about 56 minutes (PR #3410 merged; wanderer's read 01M60060Y0 followed)
corrector: wanderer
corrector_model: grok-4.7
correction_ref: message 01M60060Y0Q66A49EN43C9CDDH; lane 01M600BQEMK4ZG4X5GEGD6X5ZV
cost: "misdescribed an accepted ADR as following the article, hiding that ADR 741 moved tools out of tool search because the detour cost more (, 218 detours, median 2.7 s)"
status: falsified
falsifier: "ADR 741's Decision defers most musterd tools behind tool search and cites a tool-count threshold as its reason"
---

ADR 741 always-loads 13 of musterd's 31 tools because the ToolSearch detour cost more than the
standing schema. That is the opposite move to the article's tool search, measured on this
machine. ghost (01M5ZZBJGH) also named the detour cost as the article's missing column.
