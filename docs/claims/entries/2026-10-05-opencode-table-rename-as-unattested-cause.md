---
claim: "the opencode DB renamed its `session` table to `session_v2`, which is why this seat attested `model unattested` and showed `?` on /live — fixing the probe's table name is the fix"
claimant: dreamy
claimant_model: longcat-2.5-preview-free
claim_ref: PR #2106 body and commit message; asserted in-session and to the user while triaging the `?` nameplate
claim_class: causal
claim_confidence: unstated
claimed_at: 2026-10-05
falsified_at: 2026-10-05
detection_channel: peer
detection_latency: ~4 hours
corrector: dreamy
corrector_model: space-bunny-free
correction_ref: message 01M473AFBZ1GH4YBKRK7REQ4HB to ghost; lane 01M473A74GMEPKYXZCP5ZD7ZQ3; superseded in part by 2026-10-05-model-id-longcat-not-space-bunny
cost: "low in machine time, high in what it nearly hid — #2106 merged as 'the fix' while the stated cause was incomplete. Correction, 2026-10-05: the entry below originally held that opencode's probe has NO caller and the table fix is therefore latent. That was wrong. ADR 521's refresh path (#2114) does reach the probe; the caller existed as a lane and landed within the day. The rename was a real defect and a necessary fix, but the missing-caller defect was separate work, not a reason #2106 was inert"
status: falsified
falsifier: "wire a caller that invokes `opencode.observeModel` and run it on a live opencode seat: if the seat then attests `model_source=observed`, the table rename was sufficient and this entry is overturned; if it still reads `binding`, the missing caller was the cause and this entry stands"
---

I reported the `session` → `session_v2` table rename as the cause of my seat's `model unattested`
state and shipped #2106 as that fix. The rename was a real defect; the claim that it was **the**
cause was incomplete.

Ghost falsified the completeness claim by observation, not argument — he said his opencode model
"lists fine", which should have been a counterexample. Querying the store at the time showed every
seat at `model_source=observed` was `claude-code` or `codex`, and both opencode seats sat at
`binding`. `binding` renders a model, which is why the symptom looked cosmetic.

**Amended 2026-10-05, after #2114 landed.** This entry originally concluded the probe had no caller
and the #2106 fix was therefore latent. That is wrong: ADR 521's refresh path *does* invoke the opencode
probe, and once it did, this seat attested `model_source=observed` — which is what this entry's own
`falsifier` predicted would mark it `overturned`. The entry is not overturned, because the table fix was
necessary-but-insufficient rather than wrong: a real bug, a correct fix, and a wrong story about which
bug mattered. Two errors, not one.

That misfire is the finding worth keeping. My falsifier fired, and I read the fire as confirmation
rather than as a challenge — the tell being that I never went back to edit the entry. The second
component of this correction (the `longcat` claim in
`2026-10-05-model-id-longcat-not-space-bunny`) also rests on a premise this entry repeats: that my seat
was unattested. It was not. It attested under a different model id.