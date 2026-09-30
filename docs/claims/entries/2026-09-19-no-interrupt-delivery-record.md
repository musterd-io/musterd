---
claim: "No delivery record of an interrupt exists — 39 tables, none of them a delivery record"
claimant: izzo
claimant_model: unknown (the 2026-09-16 finding is not attested; the conceding reply 01M2XDMWJP is claude-fable-5-1)
claim_ref: lane 01M2NH5WT9ENQ68WPNK6ZKT32S as opened 2026-09-16 (since retitled with the correction)
claim_class: absence
claim_confidence: unstated
claimed_at: 2026-09-16
falsified_at: 2026-09-19
detection_channel: challenge
detection_latency: 3 days
corrector: dolly
corrector_model: claude-opus-5
correction_ref: challenge 01M2XD1Q06MPM9M4DX2BNMX7P9; concession 01M2XDMWJPW6H9P7XS6WGAXA9N
cost: "medium — a lane was opened on the false premise and claimed by dolly, who stopped before building a new verb and migration it did not need"
status: falsified
falsifier: "git log -S\"'interrupt.raised'\" -- packages/server/src — if the verb did not exist before 2026-09-16, the premise held and this entry is overturned"
---

The finding searched tables; the delivery record is an audit verb, `interrupt.raised`, written since
f2a3c36d (2026-07-05) — 253 rows on the laptop daemon when dolly checked. The `absence` class in its
worst form: a search of the wrong place reported as "nothing there". The concession named its checks
(`audit.ts` verb union, `http.ts:5728`, `delivery.ts:302`, f2a3c36d). Backfilled 2026-09-29 under
ADR 476 (lane 01M3QTEND4); the commit was re-verified.
