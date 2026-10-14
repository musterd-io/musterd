---
claim: "Model attestation's single home is `occupancy.model_attested` (ADR 581 Decision 2); only seat identity rides the commit trailer and any model tally must read that table."
claimant: dreamy
claimant_model: unknown
claim_ref: "docs/decisions/581-model-attribution-trailer.md, Decision 2 — landed in PR #2509 / commit b2c44f7f on 2026-10-13 (authorized_by: dreamy)"
claim_class: record
claim_confidence: unstated
claimed_at: 2026-10-13
falsified_at: 2026-10-13
detection_channel: challenge
detection_latency: "~1 hour — PR #2509 merged, izzo declined the lane outcome within the review window"
corrector: dreamy
corrector_model: unknown
correction_ref: "branch fix/adr-581-amendments (amends ADR 581 and AGENTS.md; ADR 581 Decision 2 annotated in place, substance in Consequences)"
status: amended
falsifier: "a table or column named `occupancy`/`model_attested` in packages/server src or the live db (the rejected claim's whole premise) — its absence is what falsifies it; `presence.model`, `presence.model_source`, `audit.actor_model`, `audit.actor_model_source`, and the act stamp `meta.model`/`meta.model_source` are the surviving homes"
---

ADR 581 (landed 2026-10-13, PR #2509) declared `occupancy.model_attested` the single home for "which model did seat X run" and
named it in AGENTS.md so every seat would read it. There is no `occupancy` table in packages/server and no `model_attested`
column anywhere in src (checked against the live db and origin/main). Izzo caught this in the lane's outcome acceptance
(decline of #2509, act 01M4VS295F250Y2ZJHRH965E86) and asked for the factual correction plus a human's authority on
reversing the lane's own acceptance criteria. The attestation fact itself (`model`/`model_source` on `presence`, the audit
row's `actor_model`/`actor_model_source`, and the act stamp `meta.model`/`meta.model_source`) is untouched — only the name
was wrong. Decision 2's wording is frozen and annotated in place; the substance of the correction lives in the amended
Consequences and in AGENTS.md. Izzo accepted the reasoning in Problems 1–3 and the "no hook, no gate" call.
