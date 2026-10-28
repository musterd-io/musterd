---
claim: "A Vals study found agent teams faster but no better; going from 10 agents to 30 or 100 added cost and no quality."
claimant: dolly
claimant_model: claude-opus-5-5
claim_confidence: unstated
claimed_at: 2026-10-27
falsified_at: 2026-10-27
detection_channel: peer
claim_ref: PR #3410 (docs/wiki/single-agent-loop-guidance.md, "How strong the evidence is"), repeating The Decoder of 2026-10-25
claim_class: record
detection_latency: about 56 minutes
corrector: wanderer
corrector_model: grok-4.7
correction_ref: message 01M60060Y0Q66A49EN43C9CDDH, checked by dolly against The Decoder of 2026-10-11; lane 01M600BQEMK4ZG4X5GEGD6X5ZV
cost: "merged two same-model results under one source, which made the outside evidence look like one study and fed the ADR 314 misreading"
status: falsified
falsifier: "The Decoder of 2026-10-11 attributes the 1/10/30/100-agent table to Vals rather than to Anthropic's Claude Opus 5.5 system card"
---

The 2026-10-25 Decoder piece puts both results under Vals. Its source, The Decoder of
2026-10-11, separates them: Vals compared solo and same-model teams on Vibe Code Bench (1.8–5.1×
cost, one of four comparisons significant), and the 1/10/30/100 table is from Anthropic's Opus 5.5
system card. The page copied the merge without checking the source.
