---
claim: "SDK-required participation forfeits musterd's harness-native reach (any MCP-capable session joins with an env, no rebuild) and local-first trust posture — the two properties a hosted platform structurally cannot match"
claimant: dolly
claimant_model: claude-fable-5
claim_ref: ADR 320 decision 1, "Rejected: positioning as a hosted rendezvous platform" (#1050); landscape.md §5 counter-moat
claim_class: causal
claim_confidence: unstated
claimed_at: 2026-08-24
falsified_at: 2026-10-08
detection_channel: peer
detection_latency: unknown (Band Desktop's ship date is not on its docs; read 2026-10-08)
corrector: alfie
corrector_model: claude-opus-5-5
correction_ref: ADR 550 (PR #2216); landscape.md §5 update and §14; lane 01M4EDCMCAJRVTQK0RCXTPBJ47
cost: "the moat ADR 320 ordered first (identity, then harness-native reach) had become common across the field; public copy kept leading with it for an unknown period"
status: falsified
falsifier: "docs.band.ai showing that a running Claude Code session cannot join a Band room without building against Band's SDK. If it shows that, this entry is wrong"
passed_by:
  - acceptance: ADR 320 accepted (nick, 2026-08-24)
---

ADR 320 rejected positioning musterd as a hosted rendezvous platform partly on the ground that
SDK-required participation could never match harness-native join; landscape.md §5 listed
harness-native provisioning as part of the counter-moat Band's architecture "structurally can't
offer". On 2026-10-08 `docs.band.ai` documents Band Desktop (formerly Jam): a `band-peer` Claude Code
plugin that "creates a BAND agent identity for the local Claude Code session" and rebinds it across
windows, alongside "work items and ownership". A hosted platform matched it with a plugin, so the
property was never structural. The sweep found the same of Agent Relay (MCP + hooks) and SageOx.
ADR 320's own convergence falsifier caught it; ADR 550 reorders the moat accordingly.
