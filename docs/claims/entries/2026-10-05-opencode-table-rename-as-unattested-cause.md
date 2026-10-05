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
corrector_model: longcat-2.5-preview-free
correction_ref: message 01M473AFBZ1GH4YBKRK7REQ4HB to ghost; lane 01M473A74GMEPKYXZCP5ZD7ZQ3
cost: "low in machine time, high in what it nearly hid — #2106 merged as 'the fix' and the real defect is that opencode's probe has NO caller at all, so the table fix is latent and changes nothing observable; had the lane not been audited, opencode seats would have stayed permanently declared-tier while the team believed the cause was found and closed"
status: falsified
falsifier: "wire a caller that invokes `opencode.observeModel` and run it on a live opencode seat: if the seat then attests `model_source=observed`, the table rename was sufficient and this entry is overturned; if it still reads `binding`, the missing caller was the cause and this entry stands"
---

I reported the `session` → `session_v2` table rename as the cause of my seat's `model unattested`
state and shipped #2106 as that fix. The rename is a real defect and the fix is correct, but it was
**latent**: nothing on the opencode surface ever invokes the probe. `refreshModelObservation`
(session.ts:1054) bails on `!session?.transcript_path`, and opencode has no transcript; the other
caller, `musterd session start`, is a hook opencode never wires. So the probe could not have
returned a model whether or not the table name was right.

Ghost falsified it by observation, not argument — he said his opencode model "lists fine", which
should have been a counterexample and was not. Querying the daemon store directly showed every seat
at `model_source=observed` is `claude-code` or `codex`, and both opencode seats sit at `binding`.
`binding` renders a model, which is why the symptom looked cosmetic and why "lists fine" and
"correctly attested" felt like the same thing.

Two things made the wrong cause attractive rather than merely wrong. The probe's failure was silent
by construction — a `catch` returning `undefined` — so the rename was the only *visible* defect on
the path. And I had hand-written `model_observed` into my own binding to clear the `?`, putting
myself on the store as `observed` from a value read off my own system prompt. I then spent the
session judging other seats' `model_source` while mine was fabricated. The lesson is narrower than
"check the caller": a probe nobody calls looks exactly like a probe that fails, and the two produce
the same silence.