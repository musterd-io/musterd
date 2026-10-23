---
claim: "Over all 20 pairs of the CooperBench claim run, after every one of the 29 held-file refusals the refused agent messaged or asked the holder, and none used the one-call until_lane wait."
claimant: lazara
claimant_model: claude-opus-5-5
claim_ref: PR #3217 (docs/research/022-cooperbench-coordination-residue.md, result and held-file table; restated in #3226, the ADR 691 Consequences note in #3219, the code comment in gate.ts, and the CooperBench progress page; lane 01M5JMCKWRNQ08GH9B6HT35MQ3)
claim_class: measurement
claim_confidence: unstated
claimed_at: 2026-10-22
falsified_at: 2026-10-23
detection_channel: self
detection_latency: about 19 hours (PR #3217 merged 2026-10-22 ~20:28Z; caught 2026-10-23 while writing the riders' readout)
corrector: lazara
corrector_model: claude-opus-5-5
correction_ref: lane 01M5KHD19KRM01Z2AJT1K3R1K9 (readout.py held_refusal_moves, finding 022 and ADR 691 dated corrections)
cost: "the 'every … none' figure was the stated reason for #3219 and the baseline the next measurement would have used (0/29 instead of 2/29); #3219 itself still stands, since 19 of 29 did message first"
status: falsified
falsifier: "held_refusal_moves misreads the streams: a hand-inspection of the claim run's 29 refused agents' streams (claim-musterd-core, claim-musterd-new) finds no until_lane wait as the first musterd move after a held refusal, or finds fewer than 2"
passed_by:
  - acceptance: lane 01M5JMCKWRNQ08GH9B6HT35MQ3 accepted by ghost 2026-10-22 23:12Z (#3226)
  - dependency: lane 01M5JMN1X5N6BDA4TAVBJHRFJX (#3219, held refusal leads with the wait) depends_on 01M5JMCKWR
  - acceptance: lane 01M5JMN1X5N6BDA4TAVBJHRFJX accepted by big-body 2026-10-22 20:42Z
---

Finding 022 read "what the refused agent did next" from `readout.py`'s daemon-side heuristic,
which walks the seat's acts and audit rows after each held refusal. A blocking
`team_inbox_check {wait}` leaves neither: no act is sent and no audit row is written. So the
heuristic stepped over every wait to the next message, and reported 25 messages and 4
`request_help` in 29, with no wait at all.

Read from the agents' own streams (`held_refusal_moves`, added in lane 01M5KHD19K), the first
musterd move after the 29 held refusals was a message in 19, a plain blocking wait in 4, a plain inbox
check in 4, and the one-call `until_lane` wait in 2. "Every" and "none" were wrong. The direction
(most refused agents messaged first) and #3219's change stand. The rider that measures #3219
(`docs/research/cooperbench/riders.md`) uses 2/29 as its baseline.
