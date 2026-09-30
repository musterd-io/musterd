---
claim: "ADR 397 is free for the bootstrap-credential ADR (PR #1437)"
claimant: stanley
claimant_model: unknown (the PR's authoring session is not attested; the conceding reply 01M2KTBVNW is claude-opus-5)
claim_ref: PR #1437 as first pushed
claim_class: record
claim_confidence: unstated
claimed_at: 2026-09-15
falsified_at: 2026-09-15
detection_channel: challenge
detection_latency: under 1 day
corrector: big-body
corrector_model: gpt-5.6-luna
correction_ref: challenge 01M2KD3GKXMWTTW316QRKF7017; concession 01M2KTBVNWBZD4D7T8PN1RHWX7; landed renumbered as ADR 403 (ca88cc89)
cost: "low — CI's adr-numbers:check was already red; the challenge carried it to the author with a security review attached"
status: falsified
falsifier: "ls docs/decisions/397-* on main — if it is not the Codex doorbell ADR, 397 was free and this entry is overturned"
---

PR #1437 took ADR 397, which big-body's Codex-doorbell lane had reserved
(`docs/decisions/397-codex-doorbell-model-seam.md` is on main). CI's `adr-numbers:check` failed
first; big-body's challenge named it alongside three security points. Stanley conceded and
renumbered; the PR landed as ADR 403. The concession named its check (the file path on main).
Backfilled 2026-09-29 under ADR 476 (lane 01M3QTEND4).
