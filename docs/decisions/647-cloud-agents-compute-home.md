# 647 — Cloud agents: a hosted seat runs on musterd compute, on the sponsor's key

- Status: proposed
- Date: 2026-10-17
- Lane: `01M50SQBJGHRY9HKPDH8WMDBDK` (goal `cloud-agents`)
- Deciders: nick, in the 2026-10-17 brainstorm with fifty
- Design: `docs/superpowers/specs/2026-10-17-cloud-agents-design.md`
- Builds on: ADR 463 (sponsor-hosted agents), ADR 588 §8 (the resident seat is the local half of
  Cloud increment 8), ADR 583 (metering gateway), ADR 461 (Cloud topology and pricing)

## Context

musterd Cloud hosts teams (goal `cloud`), and the native harness runs agents on a member's
machine, including the resident seat (ADR 588) and sponsor-hosted agents on the sponsor's own
machine (ADR 463). Nothing runs an agent on musterd's compute, so a team's agents stop when no
member's machine is up. Cloud increment 8 (`01M3TTZP5HF8QZZW0SA8VZAXSJ`) names the work in one
line; the business plan already lists always-on hosted seats as a credit sink, "planned, not
promised". The one measured precedent is `delta`: a per-seat Fly machine running a joiner daemon
(ADR 390, `docs/perf/cloud-seat.md`), retired 2026-10-15.

## Problem

Where does a cloud agent run, whose key does it spend, how does it get its workspace and key,
how are teams isolated, and which teams may have one — decided in an order that lets each answer
be measured before the next is paid for. Starting shared or musterd-billed would spend the
isolation and spend-risk budget before any reading exists; starting on laptop hubs would make
"always on" depend on a laptop being awake.

## Decision

1. **Phased compute, machine boundary first.** Phase 1: one Fly Machine (a Firecracker microVM)
   per hosted seat, auto-stopped when idle. Phase 2: one agent machine per team, on phase 1's
   cost data — never the team daemon's machine, because the daemon holds the team database.
   A shared multi-tenant pool is a later phase, only on isolation evidence and its own ADR; a
   jail-only boundary between teams is refused at every phase.
2. **The executor is the resident seat, moved.** A cloud agent is ADR 588's resident seat (pi
   engine, `engines/jail.ts` working tools, ADR 605 keychain) with its wake actuator on musterd
   compute, provisioned through ADR 463's sponsor-scoped provisions and host key — the key
   musterd-minted, the scope the sponsor's. No new engine, no new provisioning path.
3. **BYOK first; credits buy compute only.** Phase 1 spends the sponsor's own API key, held per
   seat on the agent machine, revocable by the sponsor alone; model calls use no credits
   (business plan). Credits charge machine uptime per seat. The ADR 583 gateway meters every
   call whatever key it spends, and the ADR 611/639/641 caps hold a cloud seat exactly as a
   local one.
4. **Subscription-login seats are phase 2.** A sponsor may log their own harness subscription in
   on the agent machine in a device-auth flow they complete; that seat runs the harness, not the
   resident engine. Named as the sponsor's credential on musterd compute at provisioning, and
   only after the provider's terms for it are answered in writing.
5. **Hosted teams first; laptop-hub joiner second.** Phase 1 serves hosted (Cloud) teams only.
   Phase 2 enrols the agent machine at a member's laptop hub as a joiner, on the same
   provisioning code, with delta's friction list (hub-side `node trust`, per-daemon keys)
   discharged or named first.
6. **Isolation is stated per phase and tested.** The agent machine holds no team database and
   no credential beyond its seats' sponsor-scoped ones; one workspace per seat under the jail;
   no network beyond the gateway and the team server. A stolen machine's blast radius is its
   enrolled seats, and revoking its host key ends its leases.
7. **Lifecycle is the sponsor's.** Park grants no leases and stops the machine (a parked seat
   costs storage only and spends nothing); a directed act starts it; revoking the key or the
   seat destroys it, with the workspace's fate at the sponsor's word and on the record.

## Consequences

- Cloud increment 8 (`01M3TTZP5HF8QZZW0SA8VZAXSJ`) is re-scoped by phase; its dependency on
  Cloud increment 6 stands. The lanes in the design's §6 carry the build.
- The keychain on a Fly machine is not ADR 605's local keychain; its equivalent and threat
  model are phase 1's security read with the security role.
- Per-seat cost is measured before pricing: the credit price of a seat-day is proposed to nick
  from phase 1's pilot reading, not set here.
- musterd-billed and musterd-native models, and any shared pool, each need their own decision;
  this record refuses to presume them beyond the gateway already pricing every call.
- Follows-up: lane `01M50SQBJGHRY9HKPDH8WMDBDK` opens the phase lanes in the design's §6 when
  this record is accepted.

## Observability & Evaluation

- **Traces:** ADR 463's provision rows and audit (`detail.sponsor_scoped`), ADR 624 claim
  attestation per wake, gateway price rows per call, and machine uptime metered per seat —
  `/report` shows compute credits and model cost per seat, separately.
- **Eval:** the design's §5 tests (cross-sponsor provisioning refused, parked seat granted no
  lease and stopped, wake-after-park leases, caps hold, host-key revocation ends leases) plus
  phase 1's pilot: one sponsored seat on musterd compute for a week, cost per seat-day and wake
  latency against delta's log.
- **Experiment:** the pilot is the experiment; its reading prices phase 2. Falsifier: a cloud
  seat that costs more per accepted lane than the sponsor's own machine by an order of
  magnitude, or a sponsor who cannot see and stop its spend — either sends the shape back.
