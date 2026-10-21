# 689 — Sponsor-scoped credentials and host-pinned provisions replicate to joiners

- Status: proposed
- Date: 2026-10-21
- Lane: `01M55Y5E28EPF6RNTCREYKQ6CP` (goal `cloud-agents`, phase 2b)
- Builds on: [ADR 647](647-cloud-agents-compute-home.md) §4.3 (laptop-hub joiner), [ADR 648](648-sponsor-host-key-provisions.md) (a host key provisions its sponsor's seats), [ADR 393](393-residency-enrollment-projects.md) (ledger projector pattern), [ADR 325](325-multi-machine-federation.md) / [ADR 328](328-machine-credential.md) (joiners), [ADR 360](360-push-level-residence.md), [ADR 662](662-one-machine-per-hosted-seat.md) d4/d7
- Design: `docs/superpowers/specs/2026-10-21-cloud-agents-2b-joiner-design.md`
- Review gate: the security role (big-body) on the authority crossing a node boundary — design read 2026-10-21 (act `01M5DV5TR0PJD1ND4D0T93KB6G`, three issues folded into decisions 5–9), and again at lane acceptance

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
5. **A host-key-authored event names the host as its actor, never the sponsor.** ADR 648 §3
   stamps the sponsor as `actor` on rows a host key writes; at a joiner that actor is a human
   bound to the hub, and `syncEventActor` would refuse the push `bound_elsewhere`. So a row the
   host key authors carries `actor: <host label>` with `actor_kind: 'host'` and the sponsor kept
   separately in `detail.sponsor` (`sponsor_scoped: true`, `via: 'host_key'` unchanged). Push
   residence (ADR 360) skips the seat check for `actor_kind: 'host'` and instead requires that
   the pushing node is the node that host label is enrolled on (`host_liveness.node`, written at
   the host's first poll) — the one narrowly validated exception. A joiner push authored by a
   human stays refused `bound_elsewhere`; a push whose host actor does not match the pushing
   node is refused too. Both are tested on a real joiner→hub push.
6. **Provenance is bound on every credential and provision event, and only the hub's word
   projects.** A joiner-authored `credential.minted`, `host.provision_claimed` or
   `host.provision_reported` is a *request* in the log, never a fact: it projects nothing at any
   joiner, and keeps its joiner as `origin_node` (ADR 325; `sync/log.ts` stores pushed events
   verbatim). The hub, at fold time, checks that the minting host key named in the event is live
   and unrevoked, sponsor-scoped, that its creator still sponsors the target with standing and
   `can_create_agents` intact, that the event's `host` equals that key's label, and that the
   event's origin node is the node that label is enrolled on. If all hold the hub writes a
   **hub-origin** `credential.accepted` (or `host.provision_claimed` / `_reported` as its own
   row) carrying the request's event id, the hash and the scope; if any fails it writes
   `credential.refused` (audited, nothing inserted) — a credential minted under authority the
   hub has since withdrawn never materialises, whenever it arrives. Joiners project
   `credential.accepted`, `credential.revoked` and `host.provision_*` **only when
   `origin_node` is the hub's**; the fold never trusts a ledger payload or its `via` field by
   verb, and joiners never trust each other's rows. Tests: forged, wrong-sponsor, wrong-host and
   wrong-origin requests from a joiner are each refused; a two-joiner case shows a valid mint
   at joiner A reaches joiner B as a hub-origin `credential.accepted` while a forged one never
   does.
7. **Privileged verbs at a joiner need fresh hub authority; wakes do not.** The four ADR 648
   verbs (mint `claim_seat`, issue grant, enrol, revoke) and a provision claim run at a joiner
   only when its last successful pull from the hub is younger than `agent_host.freshness_ms`
   (policy, default 15 minutes — the provision cancel window, ADR 463 §2). Older than that they
   refuse `hub_unreachable` (ADR 355 §3's code) and the host loop keeps polling. Wake leases on
   seats already enrolled keep deriving from folded acts regardless — that is what the joiner is
   for, and a wake exercises no authority a revocation would withdraw beyond the seat's own
   credential, which decision 8 ends. Test: revoke on the hub while the joiner is offline → a
   local mint is refused once the window lapses, and the pre-lapse mint is refused at the hub
   by decision 6 on reconnect.
8. **Revocation is one sync tick, bounded by decision 7.** Revoking the host key or the seat
   credential on the hub projects the delete at the joiner on its next pull; leases already
   granted settle on their own clock. The staleness ADR 325 prices for every replicated fact is
   now bounded for authority by the freshness window, and unbounded only for what a wake may
   do with a credential the joiner still holds.
9. **The hash is a verifier, and it is retained.** A `credential.minted` row leaves a permanent
   copy of the sha256 in every joiner's append-only `sync_log`. The secret is 24 random bytes
   (`newSecret`), so the hash is not a bearer and inversion is not practical; the retention is
   named here so nobody mistakes the log for secret-free, and the hash never appears in a log
   line, a trace or telemetry (hard rule 5).

## Consequences

- _(2026-10-21, first landing, lane `01M5DTS8DC0S69GMQ3BN13FHKR`.)_ Decision 2 is precise about
  what crosses, not about who minted it: an admin's host key is both team-wide and the admin's own
  sponsor key (ADR 463 §1), so the row crosses and is honoured **sponsor-only** at the joiner
  (`replicated_from` set; `hostKeyScope` never grants a replicated row team-wide reach). The
  team-wide half never crosses; what never crosses at all is the team agent key, `claim_role`,
  an unsponsored `claim_seat`, and any human credential. The joiner request path, provisions,
  the host actor and the freshness window land in the lane's second PR.

- Phase 2b can stand a hosted seat up at a laptop hub with no human on the machine, on the
  phase 1 provisioner pointed at `127.0.0.1`. Delta's friction items 1, 3 and 4 disappear at the
  root rather than being patched; item 2 is settled by decision 2.
- Three new ledger tags (`credential.{accepted,refused,revoked}`, `host.provision_*`) and two projectors, dual-dialect by construction (ADR 647 §4.1b): a
  portable migration if a column is needed, store tests on both drivers. No new sync kind, no
  protocol schema change (the ledger envelope already carries `detail`).
- A stolen joiner's blast radius is unchanged from phase 1's: the host key's sponsored seats.
  The credential hashes it now also holds are of credentials it could already use, and the
  authority to mint more lapses with the freshness window (decision 7).
- `PolicySchema.agent_host` gains `freshness_ms` — a protocol schema addition, so this ADR is
  its gate (hard rule 1). `host_liveness` gains a nullable `node` column (portable migration).
- While the hub is unreachable the joiner wakes the seat on folded acts and the seat can answer
  them, but cannot claim a lane (ADR 355 §3) and its acts queue. "Always on" for a laptop hub
  means that and no more; the design §3.2 says so and the dogfood reading measures it.
- Follows-up: lanes `01M5DTS8DC0S69GMQ3BN13FHKR` (sync projectors), `01M5DTSFB6MN2T3BPRBFRFX4A3` (host loop
  against a joiner), `01M5DTSKABX7QM3V851Y193B1M` (hub mode in `deploy/cloud-agent`), `01M5DTSQ7BKX54NG9V3PHVK4A5` (the week's reading).

## Observability & Evaluation

- **Traces:** the ledger rows themselves (`credential.minted` request, hub-origin
  `credential.accepted` / `refused` / `revoked`, `host.provision_*`) stamped with `origin_node`,
  so "which node asked, what the hub decided, which folded" is one query on `sync_log`; the existing audit actions with `via: 'host_key'` at the joiner; a joiner
  claim of an unpinned or foreign-pinned provision is an ordinary deny row.
- **Eval:** the design §6 tests — cross-sponsor refusal at the joiner, team-wide key never
  replicates, revocation lands within one tick, pinned-only claims, human-authored joiner push
  refused, host-actor/node mismatch refused, forged and wrong-origin events refused at the fold,
  offline revoke → local mint refused → reconnect folds `credential.refused`, spend caps
  unchanged — on both drivers.
- **Experiment:** the week's dogfood reading on the revive hub (`docs/perf/cloud-seat.md`):
  wake latency against the laptop baseline, behaviour across hub sleeps, human steps per boot
  (target: zero after the sponsor's one `create.sh`). Falsifier: a human step on the machine or a
  `bound_elsewhere` in the week means decision 5 is wrong.
