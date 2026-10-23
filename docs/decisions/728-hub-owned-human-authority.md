# 728 — Hub-owned human authority for joiner daemons

- Status: accepted
- Date: 2026-10-23
- Lane: `01M5N54FB29MY34X741MRXAA8P` (goal `federated-human-authority`), asked for by nick
- Builds on: [ADR 325](325-multi-machine-federation.md), [ADR 328](328-machine-credential.md),
  [ADR 662](662-one-machine-per-hosted-seat.md), [ADR 580](580-human-credentials-require-human-admin.md)
- Supersedes (in part): [ADR 328](328-machine-credential.md) §3, only to add the bounded authority
  relay described below to the node credential's sync surface

## Context

ADR 325 makes a Team's hub the authority for facts that need agreement across machine daemons.
ADR 328 gives each daemon an `msnode_` credential; it identifies the machine and lets that
machine speak for seats already resident on it. ADR 662 requires A2 passkey proof for its closed
list of high-authority acts and a standing human admin's countersign when a member enrolls their
first key after team genesis.

The authority tables are daemon-local. A joiner therefore cannot see a standing key on the hub.
Its empty `device_keys` table also cannot tell whether the Team is at genesis. Running
`musterd authority enroll --confirmed-by nick` on Air 2 consequently cannot discover Nick's key
to countersign Swetha's first enrollment.

The key, challenge, descriptor and parked-proof tables are in
`packages/server/src/store/authority.ts`. Local authority routes are in
`packages/server/src/transport/http.ts`; node authentication and seat residence checks are in
`packages/server/src/sync/`. Federation does not currently replicate authority rows. That is the
right default: a local copy would become a second source of truth for enrollment, revocation,
team genesis and A2 proofs.

## Problem

Let each human complete a passkey ceremony on their own machine while preserving one linearizable
authority for team-wide human acts. A node credential must remain machine proof, and the joiner
must not infer team genesis, authorize a human by caller-supplied identity, or make a protected
write when it cannot consult the hub.

## Decision

1. **The hub owns human authority state.** The hub is the only writer and verifier for the Team's
   device-key registry, enrollment challenges, approval descriptors, parked proofs, countersign
   decisions and high-authority writes. Joiners do not store, synchronize or verify device keys,
   challenges, descriptors or parked proofs. Their local `/authority/*` routes are a client
   surface that relays to the hub; they never make a local authority decision.

2. **A node credential proves the node only.** Extend the node-authenticated sync surface with a
   bounded authority relay, using strict protocol schemas for each supported operation. This is
   the sole addition to ADR 328 §3. It does not give a node a human credential, a general member
   API, or permission to execute a high-authority act locally. The node id comes from successful
   `msnode_` authentication, never a request field.

   For every actor-bearing relay, the hub resolves the requested human against its own current
   Team roster, checks standing and human kind, and calls `assertSeatAlreadyResident` for that
   authenticated node before any protected read or write. The actor field is a member selector,
   not proof of identity. Capabilities and the operation's authorization are recomputed at the
   hub. A supplied node id, role, capability, authority result or origin is ignored or refused;
   none can override authenticated state.

3. **Existing local operations retain one entry point.** A local authority request is handled
   directly only when the receiving daemon is the hub. On a joiner, the same operation is
   forwarded over its enrolled node channel to the hub's authority relay. The relay accepts only
   the existing device-key operations, descriptor creation, proof presentation and listed
   high-authority operations; it is not a generic HTTP proxy. The hub returns the operation result
   to the joiner and records the hub-side audit/event. Device-key and temporary approval state
   stay hub-only; resulting append-only audit events use the existing federation sync path.

4. **Enrollment is decided against hub state.** The joiner requests a challenge for the human
   bound to its local Workspace. The hub checks that human's current membership and residence on
   the authenticated node, then evaluates team-wide key state. Only the hub may take the genesis
   path. A joiner's empty local key table never means genesis.

   The hub binds the one-use enrollment challenge to the Team, member, authenticated node, that
   node's configured ceremony origin and relying-party id, and expiry. The origin mapping is
   hub-side configuration keyed by authenticated node id; the node cannot choose an origin in the
   challenge request. After team genesis, enrollment by a human without a standing key requires a
   `device_key_admin` descriptor for a different human admin with a standing key, as ADR 662
   requires. The hub serves that countersign ceremony from its own configured origin; the new
   member's registration ceremony runs on the joiner's configured local origin. The hub commits
   the public key only after it verifies the challenge, user-verified registration, node binding,
   countersign and current admin capability. The passkey private key remains in its authenticator.

5. **A proof stays bound to the operation and node.** The hub builds the descriptor from the
   resolved human, closed-list act, target, canonical payload, Team, expiry and one-use nonce.
   The hub stores the authenticated node id alongside the descriptor and challenge and requires
   the same node at presentation. The joiner cannot choose or change the descriptor fields. The
   hub verifies the proof and current membership, role, key and revocation state at the moment it
   commits the write. A payload change, replay, expiry, wrong node, wrong member or revoked key is
   refused without a protected side effect.

6. **The hub validates WebAuthn origins from configuration.** The joiner's browser page is
   served on that daemon's own configured origin. For each authenticated node, the hub selects the
   ceremony origin and relying-party id from its node-to-origin configuration and stores them in
   the one-use challenge. The hub requires an exact match between that pinned origin and
   `clientData.origin`, then checks the pinned relying-party id against the origin. The selected
   origin must also be in the hub's `webauthnOrigins` allowlist. `Host`, `Forwarded`,
   `X-Forwarded-Proto`, and request-body fields never add or select an expected origin. A challenge
   or proof cannot change the configured origin policy.

7. **Only the hub performs high-authority writes.** Every listed act initiated on a joiner is
   forwarded with its exact payload and A2 proof. The hub verifies the proof and current
   authorization, performs the write once, and records the initiating human and authenticated
   node in the audit detail. The hub's result is returned to the joiner; its resulting event
   reaches joiners through normal sync. Key listing from a joiner is a hub read scoped to the
   authenticated human's own keys. Revocation is committed at the hub and takes effect there
   immediately; a joiner never trusts a cached key or revocation state.

8. **A hub outage fails closed for authority.** A joiner uses the established hub-unreachable
   refusal for enrollment, key management, approval, proof verification and listed high-authority
   acts. It does not fall back to its local tables or queue a protected write for later. Ordinary
   local coordination remains usable and syncs when connectivity returns.

9. **The node is not a WebAuthn origin.** Countersign pages are served by the hub, and registration
   and assertion pages by the joiner that hosts the human's ceremony. No approval descriptor,
   challenge, nonce, signature, proof, human credential or private key is logged. A bounded proof
   may cross the authenticated node channel only when needed for the hub to verify that exact
   operation; it is never replicated or retained on the joiner.

## Alternatives

- **One shared daemon for both machines.** This removes the authority relay, but makes Air 2's
  ordinary coordination depend on the hub machine and its network. Keep the local daemon on each
  machine, as ADR 325 allows.
- **Replicate public device keys and revocations.** This would let a joiner verify proofs locally,
  but makes enrollment, genesis and revocation distributed state and creates stale-key windows.
  Keep authority state at the hub.
- **Let the joiner decide for the human.** This would trust a node bearer or caller-supplied
  actor field as human proof and bypass ADR 662's A2 gate. Refuse it.
- **Cache approval or queue a protected write for later.** A previously valid proof cannot
  establish current membership or revocation state during a partition. Refuse it.

## Consequences

- The node credential's scope from ADR 328 §3 gains one narrowly bounded surface. The hub still
  authenticates the node and checks each requested human's current residence before authority
  operations.
- The relay and its request schemas are protocol changes. Increment 2 must add them only after
  this ADR is published and must update `SPEC.md` Appendix A.27 and the protocol/server chapters
  in the same change as implementation.
- Passkey ceremony pages stay on local daemon origins, while every team-wide decision stays at
  the hub. The hub configuration must map each node to its ceremony origin and relying-party id,
  and include each origin in `webauthnOrigins`.
- The hub is the only place to inspect or revoke team device keys. A joiner cannot make progress
  on human authority while the hub is unavailable; ordinary local coordination is unaffected.
- No runtime dependency is added. The existing node credential, A2 descriptor, WebAuthn verifier,
  federation client and sync path are reused.

Follows-up: 01M5N55GVEHPPGVWFERB26K0KN
Follows-up: 01M5N55P48Z932JT19DFFP1NDT

## Observability & Evaluation

- **Traces.** The hub's existing `authority.approved`, `authority.refused`,
  `device_key.enrollment_challenge`, `device_key.enrolled` and `device_key.revoked` audit events
  record the human actor and authenticated node. Refusals include a stable reason such as
  `node_not_resident`, `wrong_node`, `wrong_origin`, `expired`, `nonce_reused` or `hub_unreachable`.
  Logs and audit details exclude credentials, private keys, signatures, proofs, descriptor payloads
  and raw challenges.
- **Eval.** Transport/store tests prove the hub completes a valid two-node first-key enrollment;
  the joiner cannot take genesis when the hub already has a key; nonresident, agent, forged-actor,
  forged-node, wrong-origin, replayed, expired and revoked-key requests make no protected change;
  a changed payload fails descriptor verification; hub outage refuses authority but a local message
  still succeeds; and key listing returns only the authenticated human's keys. A manual Nick-on-hub,
  Swetha-on-joiner acceptance run verifies the passkey pages open on their configured origins.
- **Experiment.** On the first two-human/two-machine run, record which origin each passkey ceremony
  used, the hub node id on the enrollment and high-authority audit events, and the result of the
  ordinary-message control while the hub is unreachable. The implementation is falsified if a
  protected write occurs on the joiner, an empty joiner key table enables genesis, or any listed
  high-authority act succeeds without a fresh hub verification against current state.
