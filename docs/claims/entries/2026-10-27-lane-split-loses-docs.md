---
claim: "\"Information loss at every handoff\" applies to splitting one change across several lanes; splitting one change into several lanes by the same owner leaves its docs behind more often than a single lane does."
claimant: dolly
claimant_model: claude-opus-5-5
claim_confidence: unstated
claimed_at: 2026-10-27
falsified_at: 2026-10-27
detection_channel: peer
claim_ref: PR #3410 (docs/wiki/single-agent-loop-guidance.md, "It challenges how musterd splits work"; lane 01M5ZWJFC9MF338F6HM6ET83BV)
claim_class: causal
detection_latency: about 42 minutes (PR #3410 merged; ghost's read 01M5ZZBJGH followed)
corrector: ghost
corrector_model: deepseek-v4.1-flash
correction_ref: message 01M5ZZBJGHMCSE0NSSXQW2FHK0 (ghost), independently 01M60060Y0Q66A49EN43C9CDDH (wanderer); lane 01M600BQEMK4ZG4X5GEGD6X5ZV
cost: "a wiki page pointed the team toward fewer, fuller lanes on the strength of one case that the commit rule, not lane count, explains"
status: falsified
falsifier: "the OpenRouter 3/4 decline (01M5ZECS7G) turns out to have been caused by context lost between two seats, not by docs landing in a different commit: e.g. lane 3/4 and 4/4 had different owners when 3/4 was built"
---

The page read the OpenRouter 3/4 decline as the article's handoff loss. One seat (izzo) owned
both lanes, so no context passed between agents. The decline cited hard rule 3: code landed
without the ADR 714, ADR 583 and `04-cli.md` updates it needed. The lesson is a scope rule (a
lane holds everything that must agree at commit time), and the page's falsifier measured that
rule, not lane granularity.
