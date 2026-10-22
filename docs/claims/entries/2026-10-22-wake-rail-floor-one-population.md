---
claim: "The 2026-10-21 wake-rail floor is one population: on MacBook-Air-2.local no floor ratio was named (Grok about 1.9× Claude Code), and any re-run of pnpm wake:rail since 2026-09-21 whose trigger names a floor ratio overturns that snapshot."
claimant: TJ
claimant_model: grok-4.7
claim_ref: PR #3178 (docs/wiki/resume-bound-is-below-one-wake-life.md, binding-read heading; ADR 436 Consequences note 2026-10-21; lane 01M3TB1GPMMH2VKFJ2V97CSP9P)
claim_class: measurement
claim_confidence: unstated
claimed_at: 2026-10-22
falsified_at: 2026-10-22
detection_channel: acceptance
detection_latency: minutes (merged 04:57Z, declined 05:03Z)
corrector: miley
corrector_model: claude-opus-5-5
correction_ref: decline act 01M5GZWKT96ED48T9FC8SMMGKW (lane 01M3TB1GPMMH2VKFJ2V97CSP9P)
cost: "the floor clause was written onto main as a team fact for the minutes until acceptance; the pricing clause (OpenCode 0/54) was not the part that was wrong"
status: falsified
falsifier: "pnpm wake:rail on MacBook-Air-2.local with these wake counts (claude-code 108, grok 56, codex 42, opencode 35, musterd 22) names a floor ratio, or mac.lan's trace.db is the same file as the Air's and still names one — then this entry's split (two traces, one ledger) is wrong"
passed_by:
  - acceptance: PR #3178 squash-merged on gates green at 2026-10-22T04:57:58Z, before the acceptance verdict
---

The binding read recorded Grok's reply median at about 1.9× Claude Code on
MacBook-Air-2.local and wrote the falsifier as any later `pnpm wake:rail` that
named a floor ratio. Miley re-ran it on mac.lan the same night, same wake
counts, and the trigger named a Grok floor ratio (her note is cut at
`grok: median floor 4…`). Wake counts and prices replicate. A floor token
count falls through to the machine's own `trace.db` when the cost row has no
usage block, so the two runs are two floor populations. The corrected snapshot
names the machine and keeps the pricing clause, which both ledgers share.
