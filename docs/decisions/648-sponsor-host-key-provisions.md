# 648 — A sponsor host key may provision its own sponsored seats

- Status: proposed
- Date: 2026-10-17
- Lane: `01M55Y58R3D1CCBERNJCXBJZQ9` (goal `cloud-agents`)
- Builds on: ADR 647 (cloud agents), ADR 463 §1/§3 (sponsor-scoped authority, the provisioner),
  ADR 344/395 (host keys), ADR 459 (hosting gated by `can_create_agents`)
- Review gate: the security role (big-body) on the authority extension, at lane acceptance

## Context

ADR 463's provisioner stands a sponsored agent up on the sponsor's own machine. It rides two
identities: the host key claims and reports the provision, and **the sponsor's own binding**
mints the seat's credential and grant and enrols its residency — the steps `provisionSeat` and
`residency on` perform. That is right on the sponsor's machine, where the sponsor's binding
already lives.

Cloud agents phase 1 (ADR 647) puts the host on musterd compute. The sponsor's binding must
never live there: it is the sponsor's full seat identity, and the agent machine's blast radius
is supposed to be its enrolled seats only. So today a cloud host can claim a provision and then
cannot finish it. The seat credential it needs to mint is sponsor-scoped already in intent —
ADR 463 §1 lets the sponsor mint a `claim_seat` credential for an agent they sponsor — but the
caller must be the sponsor member, authenticated as that member.

## Problem

Give a host the one missing ability — finish provisioning the seats it may already serve —
without giving it the sponsor's identity, a team-wide reach, or any new credential type. The
host key already authenticates (ADR 395), already resolves to a sponsor scope on every use
(`hostKeyScope`: creator, sponsor standing and `can_create_agents` re-checked per request), and
already may wake and report only that sponsor's sponsored seats (`hostMayServe`). Provisioning
is the same class of act, one step earlier.

## Decision

1. **A sponsor host key may call exactly four provisioning steps, for seats its creator
   sponsors, and nothing else:**
   - `POST /agent-bootstrap-credentials` with `use: 'claim_seat'` and `target` an agent the
     key's creator sponsors;
   - `POST /grants` with `scope: 'seat'` and the same target rule;
   - `POST /residency/enroll` where `body.host` equals the key's own host label (`target`) and
     `body.seat` passes the same rule;
   - `DELETE /agent-bootstrap-credentials/:id` where the credential is a `claim_seat`
     credential whose `target` passes the same rule (the provisioner's failure cleanup).
2. **The scope is resolved the host-key way, per request.** The caller is authenticated as a
   host credential (`use_kind: 'host'`, label matching as the wake routes require), its scope
   comes from `hostKeyScope` — a creator who has left, lost standing, or had
   `can_create_agents` withdrawn fails closed on the next call — and the target must satisfy
   `assertSponsorOf` against the **creator**, exactly as if the sponsor called. A team-wide
   (admin-minted) key gains nothing here: this path exists only where a creator sponsors the
   target. Self-sponsored lookup is by creator member id, never by a name in the request.
3. **The audit names both identities.** Rows written under this authority carry
   `actor: <sponsor name>` and `sponsor_scoped: true`, plus `via: 'host_key'` with the host
   label — or, on the enrolment's `grant.issue` row whose `via` already names its route,
   `host_key: <label>` — so a provisioned seat's record shows the sponsor, the machine, and
   the path taken. The credential-use row the wake routes already write is unchanged.
4. **The client follows.** `provisionOnce` gains a mode where one host-key client performs the
   claim, the provisioning steps and the report — no sponsor binding on the machine. The
   sponsor-binding mode is unchanged and stays the default for a sponsor's own host. The cloud
   host is the new mode's first user; nothing about workspace, jail or engine changes.
5. **What this does not grant.** _(Amended 2026-10-19 by [ADR 671](671-host-key-reads-cloud-roster.md):
   on a cloud team the key also reads the roster at the public grade — the wake loop's occupancy
   and kind reads — and nothing else.)_ No `use: 'host'` or `claim_role` minting, no grant scope other
   than `seat`, no enrolment under another host's label, no act as the sponsor member anywhere
   else. A stolen cloud host key can provision and wake its sponsor's sponsored seats — the
   same reach it already has over their wakes — and can mint a fresh `claim_seat` credential
   for one of them; it cannot reach another sponsor's seats, a human seat, or team governance.
   Revoking the host key, withdrawing `can_create_agents`, or the sponsor leaving ends it on
   the next request.

## Consequences

- Cloud agents phase 1 can provision on musterd compute with no sponsor identity on the
  machine; the Fly packaging and lifecycle are the phase lane's later increments.
- The four endpoints gain a second caller class. Their existing admin and sponsor-member
  callers are unchanged; the response shapes are unchanged, so no protocol schema changes.
- Tests pin the boundary on both drivers: own sponsored seat provisions end to end under a
  host key; another sponsor's seat, a human seat, `use: 'host'` minting, a foreign host label
  and a withdrawn sponsor are each refused.
- Follows-up: lane `01M55Y58R3D1CCBERNJCXBJZQ9` (the phase-1 increments after this one:
  Fly packaging, park/wake/stop, the pilot).
- _2026-10-19:_ the first cloud wake found the key could not read the roster the actuator
  verifies against (spec §4.3 refuses a non-member on Cloud); [ADR 671](671-host-key-reads-cloud-roster.md)
  grants that one public-grade read.

## Observability & Evaluation

- **Traces:** the existing audit actions (`bootstrap_credential.minted`, `grant.issue`,
  `residency.enrolled`, `bootstrap_credential.revoked`) with `via: 'host_key'` and the host
  label in `detail`; a refusal is the endpoints' ordinary deny row. Provisioning by host key
  is countable per sponsor and per host from those rows alone.
- **Eval:** the boundary tests in the Decision; plus the provisioner test running the whole
  stand-up (workspace, credential, grant, enrol, ready report) under one host-key client.
- **Experiment:** n/a — an authority extension, judged by its tests and the security review at
  acceptance, not by a rollout metric.
