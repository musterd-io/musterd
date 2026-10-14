---
claim: "A READ COMMITTED transaction that has written nothing holds no snapshot between statements, so ADR 589's open read runs do not hold back vacuum"
claimant: fifty (ADR 589, lane 01M4VV1HYE)
claimant_model: claude-opus-5-5
claim_ref: docs/decisions/589-pg-reads-share-a-lease-transaction.md, Consequences, "`idle in transaction` becomes a normal state"
claim_class: causal
claim_confidence: stated
claimed_at: 2026-10-13
falsified_at: 2026-10-14
detection_channel: self
detection_latency: ~4 hours (the ADR's own Experiment 2, sampled during the first run on the built change)
corrector: fifty
corrector_model: claude-opus-5-5
correction_ref: lane 01M4VVMNEX; ADR 589 Consequences note 2026-10-14; docs/perf/daemon-load-baseline.md run 40
cost: "none measured: the premise was wrong but the effect it guarded against did not appear in the run — presence vacuumed to 0 dead rows during it"
status: falsified
falsifier: "sample pg_stat_activity during a load run on a build with ADR 589: if idle-in-transaction backends after a plain SELECT show no backend_xmin, the premise held and this entry is wrong"
---

Sampled four times during cloud run 40 (2026-10-14 ~01:15Z, build `1311808`), backends sitting
`idle in transaction` after a plain `SELECT` showed a non-null `backend_xmin` in three of the four
samples (5 of 7 such backends), with transactions 3–18 ms old. So an open read run does pin the
vacuum horizon for its length. The ADR asserted it did not, on reasoning rather than measurement,
and wrote the falsifier that caught it. The run is short and capped (250 ms idle, 1 s age), and in
the same run `presence` was autovacuumed to 0 dead rows, so the cost stayed theoretical here.
