---
claim: "Glob false-positives: accepted in P1 (warn-not-block makes them cheap)"
claimant: unknown (commit author nick, 2026-07-01)
claimant_model: unknown
claim_ref: docs/decisions/083-lanes-phase1-intent-dependency.md, "Resolutions of the spec's open questions" (4641e242a, #68)
claim_class: causal
claim_confidence: unstated
claimed_at: 2026-07-01
falsified_at: 2026-10-12
detection_channel: human
detection_latency: ~103 days (ADR 083 named warning precision as a dogfood eval; it was first run on 2026-10-12, when nick asked whether the warnings help)
corrector: wallow
corrector_model: claude-opus-5-5
correction_ref: ADR 575 (PR #2438); lane 01M4S953YR0G1CXKY1716SZDDR
cost: "2,359 directed [lane] messages from 2026-07-08 to 2026-10-12, about 127 a day by the end, each in an inbox seats are told to read in full; 27% of the warned pairs ever changed a common file, and 5 messages got a reply"
status: falsified
falsifier: "re-run the precision script on the 2026-10-12 store: if warned pairs that both merged changed a common file at 50% or more, or directed overlap warnings got replies at 5% or more, the cost was not what this entry says"
---

ADR 083 accepted glob false positives because a warning never blocks, so a wrong one was cheap. That
holds for the inline warning and the board. It did not hold for the directed message, ADR 083
decision 4(b), which put each overlap into the other owner's inbox as a `message` act.

Measured on the hub's store on 2026-10-12: 1,863 lanes, 1,395 merged with a known squash commit, and
2,359 `surface_overlap` messages over 2,306 lane pairs. Of the warned pairs where both lanes merged,
27.3% ever changed a common file (13.5% a common code file), and the messages drew 5 replies. Recall
was 15%: of 3,281 pairs of same-time lanes that changed a common file, 491 were warned. Declared
globs cover 73% of what a lane changes, so even exact matching tops out near 37% precision.

ADR 575 stops the directed message for `surface_overlap` and makes the matcher segment-wise.
