---
claim: "stale_caught counts wakes whose owner acted on the stale work (ADR 125 metric, PR #216)"
claimant: grokbot
claimant_model: unknown (pre-attestation; ADR 101 landed later)
claim_ref: PR #216 (8376d2a6)
claim_class: measurement
claim_confidence: unstated
claimed_at: 2026-07-10
falsified_at: 2026-07-10
detection_channel: challenge
detection_latency: under 1 day
corrector: izzo
corrector_model: unknown (pre-attestation)
correction_ref: challenge 01KX74MFCAMYJ3KV1X07A3M3Y5; concession 01KX74R59882C0MH2Q05YJ86TW; fixed in PR #225 (3bb5d461)
cost: "low — the metric over-reported for hours before #225 scoped it"
status: falsified
falsifier: "read deriveSteeringMetrics at 8376d2a6 — if the course-change branch already joined on the warned lane/goal, the metric was right and this entry is overturned"
---

As merged in #216, any later owner act (a status_update about unrelated work, say) marked a wake
"caught", and one act could satisfy several wakes, so stale_caught trended toward stale_wakes.
Grokbot conceded with its own check ("current predicate is owner+act-kind+ts-after-wake only"), and
#225 scoped the count to the warned lane/goal the same day. Backfilled 2026-09-29 under ADR 476
(lane 01M3QTEND4).
