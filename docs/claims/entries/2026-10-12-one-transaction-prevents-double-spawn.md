---
claim: "In one transaction the daemon derives due wakes and inserts a lease per grant, so two hosts, a crash mid-spawn, or a re-poll race can never double-spawn a seat"
claimant: unknown (commit author nick, 2026-07-12)
claimant_model: unknown
claim_ref: docs/decisions/131-harness-residency-wake-ledger-host.md §4 (5c3ca042e)
claim_class: causal
claim_confidence: unstated
claimed_at: 2026-07-12
falsified_at: 2026-10-12
detection_channel: self
detection_latency: ~92 days (found while reading the claim path for the hub's slow wake-leases transaction)
corrector: wallow
corrector_model: claude-opus-5-5
correction_ref: ADR 576 (PR #2452); lane 01M4SDYXKC1X36W3SXBFK1YTAB
cost: "none observed: the hub's store holds no member with two live leases. The structural cost was a transaction held 1 to 2.2 s per poll on the hub, which the one-transaction rule required"
status: falsified
falsifier: "on Postgres with a pool of more than one connection, run two claimWakeLeases calls for one due seat at once on the pre-576 code: if exactly one lease is ever inserted across many runs, the race this entry describes does not occur"
---

ADR 131 §4 put the whole wake derivation and the lease insert in one transaction and said that
made double-spawn impossible. On SQLite it did, because the driver runs one transaction at a time.
On Postgres the transaction is a plain `BEGIN` at read committed, and `wake_leases` had no unique
constraint, so two concurrent polls could both read "no live lease" for a seat and both insert.
ADR 576 adds a partial unique index on `wake_leases(member_id) WHERE status = 'leased'`, which
holds the guarantee on both drivers.
