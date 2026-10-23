# Human authority across a hub and joiner daemons

**Status:** Design and implementation plan approved by Nick on 2026-10-23.

## Goal

A human can enroll and use a passkey from their own machine in a federated Team, while the hub remains the single authority for team-wide high-authority acts. The joiner keeps its local daemon and ordinary offline coordination behavior.

## Context

ADR 325 gives a Team one hub and permits machine daemons to act as joiners. Local messages and other append-only events can be created on a joiner and synced; facts requiring global agreement are hub-authoritative. ADR 662 requires a passkey signature for every listed high-authority act and requires a standing human admin to countersign a member's first key after team genesis.

Today, `device_keys`, enrollment challenges, approval descriptors, and parked proofs are read from the handling daemon's SQLite database. They are not in the federation sync set. `enrollPasskeyGuarded` decides whether the team is at genesis by looking for any key in that local database. Consequently, a joiner with no local key rows cannot see the hub's standing admin key, and its empty local database must not be treated as team genesis. `musterd authority enroll --confirmed-by nick` on Air 2 therefore cannot find Nick's key to approve Swetha's first key.

Relevant decisions and implementation: [ADR 325](../../decisions/325-multi-machine-federation.md), [ADR 662](../../decisions/662-one-machine-per-hosted-seat.md), [ADR 689](../../decisions/689-sponsor-scoped-credentials-replicate-to-joiners.md), [federation data census](../../wiki/federation-data-census.md), `packages/server/src/store/authority.ts`, and `packages/server/src/transport/http.ts`.

## Decision

Keep the hub-and-joiner topology. Make human device authority hub-owned and make joiners relay authority operations to the hub over the enrolled node channel.

- The hub owns the Team's device-key registry, enrollment challenges, approval descriptors, parked proofs, countersign decisions, and verification of high-authority acts. Device keys are not copied into joiner databases.
- A joiner may host the local passkey page and collect the browser registration or assertion from the human on that machine. It relays the bounded ceremony request to the hub using its node identity. The hub binds each challenge to the Team, human, requested act, and authenticated node, then verifies the registration or proof before changing authority state or executing the protected act.
- Nick's countersign page and descriptor are served by the hub on the hub's own configured WebAuthn origin. Swetha's enrollment ceremony runs on Air 2's local daemon origin. The CLI displays the appropriate link for each ceremony and waits on the hub-owned challenge/proof state.
- The hub stores the passkey credential ID and public key. The passkey's private key remains in Swetha's authenticator. Neither human credentials nor private key material cross the node link.
- Every high-authority act originating on a joiner is checked and committed by the hub against current membership, role, key, and revocation state. The hub builds a fresh, one-use descriptor for the exact act and payload. No standing bearer grant or cached passkey approval is introduced.
- A joiner's empty local `device_keys` table never establishes team genesis. Only the hub can decide that the Team has no keys and allow the genesis path. Once any team key exists at the hub, a human with no active key needs a countersign from a different human admin with a standing key.
- If the hub is unavailable, high-authority actions fail closed with the established hub-unreachable behavior. Ordinary local coordination continues and syncs when the hub returns.

## Ceremony and act flows

### Swetha enrolls on Air 2

1. In Swetha's bound Workspace, `musterd authority enroll --confirmed-by nick` asks the local joiner to start enrollment.
2. The joiner authenticates to the hub as its enrolled node. The hub confirms the member and admin identities from its roster and creates the server-built `device_key_admin` descriptor and one-use enrollment challenge.
3. Nick opens the hub approval link on the hub machine and approves the displayed enrollment descriptor with his standing passkey. The hub verifies and parks that proof.
4. The CLI collects the hub proof and presents the enrollment challenge on Air 2's local daemon origin. Swetha completes the user-verified passkey ceremony there.
5. The joiner relays the registration and countersign to the hub. The hub checks the node binding, member, challenge lifetime and one-use status, countersign actor and descriptor, WebAuthn challenge, configured origin, and registration; then it stores Swetha's public key and audits enrollment.
6. `musterd authority keys` on either machine reads Swetha's team-owned key state through the hub. Nick's keys remain his own and are returned only when Nick is the authenticated member.

### A human performs a high-authority act from a joiner

1. The joiner asks the hub to build a descriptor from the exact act, target, actor, and payload.
2. The human approves the server-rendered descriptor with their own passkey on the local daemon origin.
3. The joiner sends the one-use proof and exact act request to the hub over its node-authenticated channel.
4. The hub verifies the proof against its current device-key state and rechecks current membership and capabilities, then performs the hub-authoritative write and records the initiating human and node.
5. The result and resulting event reach the joiner through the existing sync path. A replay, expiry, changed payload, revoked key, wrong node, wrong member, or unreachable hub is refused.

## WebAuthn origin and node binding

The browser ceremony remains on the daemon's own configured origin, as ADR 662 requires. The hub never learns an allowed origin from the request's `Host` or forwarded-proto headers. The hub accepts a joiner ceremony only when it arrives over that enrolled node's authenticated channel and matches a hub-issued, node-bound, one-use challenge. IP literals are not WebAuthn relying-party IDs; the existing localhost fallback or a configured DNS/HTTPS origin must be preserved. The implementation must document which origin Air 2's ceremony uses and prove the hub validates it against configured origins.

## Alternatives considered

1. **One shared daemon for both machines.** It gives both people one local key registry and needs no authority forwarding. It couples Air 2's coordination availability to the hub machine and network, so it is not the selected topology.
2. **Replicate public device keys to every daemon.** It could let a joiner verify passkey proofs locally, but makes registration, revocation, genesis, and stale-key handling distributed authority state. It is not selected.
3. **Hub-owned authority relayed by joiners — selected.** It preserves a single authority, avoids copying keys to every daemon, keeps the human's authenticator local, and makes high-authority acts fail closed when the hub cannot decide.

## Goals and non-goals

**Goals**

- Enroll a second human's first passkey on a joiner only after a standing hub admin countersigns.
- Keep all high-authority verification and writes at the hub, with no cached authorization.
- Preserve each machine's local daemon, local passkey ceremony, and offline ordinary coordination.
- Make member-scoped key listing and revocation behave consistently from any joined machine.

**Non-goals**

- Replicating `device_keys` or passkey challenges/proofs as general sync events.
- Changing the ADR 662 high-authority act list or weakening the user-verification requirement.
- Replacing the node transport, changing the Team's hub, or requiring all ordinary acts to make a synchronous hub round trip.
- Reusing Nick's credential or letting an agent handle either human's passkey ceremony.

## Acceptance checks

- A hub with Nick's standing key accepts Nick's countersign for Swetha's first key when Swetha enrolls on an authenticated joiner; the hub stores Swetha's public key and the private passkey stays in her authenticator.
- The same attempt fails without Nick's valid countersign, with an agent or non-admin confirmer, from an unrecognized node, with a replayed/expired challenge, or with an unconfigured WebAuthn origin.
- A joiner with an empty local key table cannot take the team-genesis path after the hub has any key.
- A high-authority act initiated on a joiner is verified and written by the hub against current role and key state; a stale/revoked proof, altered payload, replay, or unavailable hub fails closed.
- Ordinary local messages remain usable while the hub is unreachable and sync after reconnection.
- The documented two-human/two-machine dogfood run completes the enrollment and a high-authority action without either person using the other person's Workspace.

## Review notes

- Any protocol schema or wire change requires a new ADR before implementation (AGENTS.md hard rule 1).
- The current local `authority` endpoints act directly on `ctx.db`; this design requires explicit node-authenticated forwarding and hub-side execution, not a blind proxy that trusts caller-supplied actor fields.
- Public key material can be stored at the hub; private passkey material and human credentials must never cross the node channel or appear in logs.
- The hub must derive the human, capabilities, node, and expected origin from authenticated state and configured policy, never from caller prose or request headers.
