# 688 — Sponsor-scoped credentials and host-pinned provisions replicate to joiners

- Status: proposed
- Date: 2026-10-21
- Lane: `01M55Y5E28EPF6RNTCREYKQ6CP` (goal `cloud-agents`, phase 2b)
- Builds on: [ADR 647](647-cloud-agents-compute-home.md) §4.3 (laptop-hub joiner), [ADR 648](648-sponsor-host-key-provisions-own-seats.md) (a host key provisions its sponsor's seats), [ADR 393](393-residency-enrollment-projects.md) (ledger projector pattern), [ADR 325](325-multi-machine-federation.md) / [ADR 328](328-machine-credential.md) (joiners), [ADR 360](360-push-level-residence.md), [ADR 662](662-one-machine-per-hosted-seat.md) d4/d7
- Design: `docs/superpowers/specs/2026-10-21-cloud-agents-2b-joiner-design.md`
- Review gate: the security role (big-body) on the authority crossing a node boundary, at lane acceptance

## Context

Phase 1 of cloud agents hosts a sponsored seat on a Fly machine against a hosted team: the
machine runs no daemon and every provisioning and wake call hits the one Cloud server that
minted its sponsor host key. Phase 2b (ADR 647 §4.3) gives a **laptop-hub** team the same
hosted seat. nick chose the joiner shape on 2026-10-21: the machine runs its own daemon,
enrolled at the hub over the tailnet (ADR 328), so that wakes derive from folded acts while the
laptop sleeps, as delta's did (`docs/perf/cloud-seat.md`).

Delta's friction list had one root: the machine acted as nick (`team create --as nick` on the
joiner). ADR 648 and ADR 662 d7 now forbid that root — a hosted machine holds no human
credential. With the human gone, the machine's only credential is the sponsor host key, minted
on the hub. And the joiner's daemon has never seen it: credential hashes, grants and
`host_provisions` are residence-1 rows that the fold does not project (ADR 393 §2 left grants
at residence 3).

## Problem

A hub-minted sponsor host key must authenticate at the joiner's own daemon, and the provision
it is to claim must be visible there, with no human identity on the machine, no new credential
type, and no widening of what the key may do (ADR 648 decision 5).

Rejected: pointing the host loop at the hub over the tailnet (no wakes while the hub sleeps;
the joiner daemon is decorative — the remote-actuator shape nick declined), and minting the key
at the joiner (minting is a listed high-authority act, ADR 662 d4; the sponsor is not there).

## Decision

1. **Sponsor-scoped credential hashes cross the wire as ledger events.** `credential.minted`
   and `credential.revoked` (kind `ledger`, the ADR 393 pattern: a tag, two verbs, a projector)
   carry `{id, use, target, host, sponsor, sha256, created_at}` for exactly two classes:
   a `use: 'host'` key minted by a sponsor for their own host label (ADR 463 §1), and a
   `use: 'claim_seat'` credential whose target is an agent that sponsor sponsors. The projector
   upserts or deletes the `agent_bootstrap_credentials` row on every joiner. An unknown sponsor
   or target is git lag: block, don't skip.
2. **What never crosses.** The team agent key (daemon-private, delta's finding 2 answered: it
   stays per-daemon by design), an admin-minted team-wide host key, a `claim_role` credential,
   and any human credential or binding. ADR 662 d7 holds unchanged: the machine still holds no
   human authority, and a replicated host key can do at the joiner exactly what ADR 648 lets it
   do at the hub — nothing more.
3. **A host-pinned provision crosses the wire.** `host.provision_created`, `_claimed`,
   `_reported`, `_cancelled` ledger events project `host_provisions` on joiners. A joiner may
   claim **only a provision pinned to its own host label** (#3071). A pinned provision has one
   eligible host, so the claim is uncontended and needs no hub arbitration (ADR 361's rule is for
   contended ownership edges). An unpinned provision is never claimable at a joiner.
4. **The ADR 648 verbs run at the joiner, locally.** The host key authenticates at the local
   daemon (1); `hostKeyScope` resolves the creator's sponsor standing from the replicated
   roster; the seat credential (which then replicates by (1)) and its grant are minted at the
   joiner — grants stay local, ADR 393 §2 — and the enrolment replicates to the hub by ADR 393
   §1, so the hub's roster shows the seat `wakeable` on the joiner's host.
5. **Push residence holds without `node trust`.** Every event the joiner authors is the seat's
   (occupancy) or carries `via: 'host_key'` (ADR 648 §3); none is a human's, so ADR 360's check
   passes. A joiner push authored by a human stays refused `bound_elsewhere`; a test pins it.
6. **Revocation is one sync tick.** Revoking the host key on the hub projects the delete at the
   joiner on its next pull; leases already granted there settle on their own clock. A joiner
   that cannot reach the hub keeps honouring what it last folded — the same staleness ADR 325
   prices for every replicated fact, now stated for a credential.

## Consequences

- Phase 2b can stand a hosted seat up at a laptop hub with no human on the machine, on the
  phase 1 provisioner pointed at `127.0.0.1`. Delta's friction items 1, 3 and 4 disappear at the
  root rather than being patched; item 2 is settled by decision 2.
- Two new ledger tags and two projectors, dual-dialect by construction (ADR 647 §4.1b): a
  portable migration if a column is needed, store tests on both drivers. No new sync kind, no
  protocol schema change (the ledger envelope already carries `detail`).
- A stolen joiner's blast radius is unchanged from phase 1's: the host key's sponsored seats.
  The credential hashes it now also holds are of credentials it could already use.
- While the hub is unreachable the joiner wakes the seat on folded acts and the seat can answer
  them, but cannot claim a lane (ADR 355 §3) and its acts queue. "Always on" for a laptop hub
  means that and no more; the design §3.2 says so and the dogfood reading measures it.
- Follows-up: lanes `01M5DTS8DC0S69GMQ3BN13FHKR` (sync projectors), `01M5DTSFB6MN2T3BPRBFRFX4A3` (host loop
  against a joiner), `01M5DTSKABX7QM3V851Y193B1M` (hub mode in `deploy/cloud-agent`), `01M5DTSQ7BKX54NG9V3PHVK4A5` (the week's reading).

## Observability & Evaluation

- **Traces:** the ledger rows themselves (`credential.minted` / `credential.revoked`,
  `host.provision_*`) stamped with `origin_node`, so "which node minted, which folded" is one
  query on `sync_log`; the existing audit actions with `via: 'host_key'` at the joiner; a joiner
  claim of an unpinned or foreign-pinned provision is an ordinary deny row.
- **Eval:** the design §6 tests — cross-sponsor refusal at the joiner, team-wide key never
  replicates, revocation lands within one tick, pinned-only claims, human-authored joiner push
  refused, spend caps unchanged — on both drivers.
- **Experiment:** the week's dogfood reading on the revive hub (`docs/perf/cloud-seat.md`):
  wake latency against the laptop baseline, behaviour across hub sleeps, human steps per boot
  (target: zero after the sponsor's one `create.sh`). Falsifier: a human step on the machine or a
  `bound_elsewhere` in the week means decision 5 is wrong.
