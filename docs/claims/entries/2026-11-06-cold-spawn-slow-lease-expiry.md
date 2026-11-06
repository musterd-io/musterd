---
claim: "The first lease after a hub machine start expires before its spawn occupies the seat — the cold spawn is slow (workspace/session cold), and the second attempt finds it warm."
claimant: ghost
claimant_model: muse-wonder-full-1.0
claim_confidence: unstated
claimed_at: 2026-11-06
falsified_at: 2026-11-06
detection_channel: self
claim_ref: docs/perf/cloud-seat.md round-2 narrative ("the signature of a first-attempt cold start", #3990/#3994) and the premise of PR #3995 (420 s cold first-lease TTL) on lane 01M6RZ0NRAQR9BSJA42ZN5M6N2
claim_class: causal
detection_latency: ~12 h from the round-2 record; ~1.5 h from the TTL landing
corrector: ghost
corrector_model: muse-wonder-full-1.0
correction_ref: live rounds 4–5 on delta-2 (2026-11-06 18:20–19:08Z) recorded in docs/perf/cloud-seat.md "cold-lease rounds 3–5" and ADR 816's dated correction note, this PR
cost: "one residency change (#3995) and one replication change (#3997) built on the false premise; the 420 s TTL made round 5 slower than the 120 s it replaced and burnt an hourly-cap slot (reply held ~51 min); three live rounds spent reading the wrong leg."
status: falsified
falsifier: "a host-loop spawn process present inside the seat machine during a first lease's life, still running unoccupied past 120 s — that would show a spawn really can be slow, not merely stranded"
passed_by:
  - dependency: PR #3997 (fly.machine_start as a replicated ledger verb) built to serve the TTL this claim justified
---

The claim was written from the audit timeline alone: first lease minted, 123.8 s of silence,
`lease_expired`, retry woke in 2.8 s. Read from rows, that looks exactly like a slow first
spawn overtaken by its own warm-up. Nobody looked inside the machine during the first lease.

Round 5 (2026-11-06 19:01Z) did: with the cold 420 s lease live, `ps` inside delta-2's machine
showed only the daemon and the host loop — no spawn process ever existed. The mechanism is in
the boot path, not the harness. A wake order is issued exactly once, in the poll that mints
the lease (`deriveSeatPasses` skips a seat with a live lease: `gate('lease_live')`). The
cloud-agent boot sequence probes the replicated host key by POSTing the real
`/residency/wake-leases` endpoint and discarding the body (`deploy/cloud-agent/agent.sh`), so
the probe mints the first lease and strands its order before the host loop starts — round 5's
lease at 19:01:22.4Z precedes the probe's success line (19:01:24Z) and the host's first poll.
Every "slow" first attempt since round 2 was this; every fast retry was a lease minted on a
genuine host-loop poll. The spawn itself occupies in ~3 s when it is ever attempted.
