# Federated Human Authority Implementation Plan

**Goal:** Let Nick and Swetha enroll and use their own passkeys from separate machines while the hub remains the single authority for team-wide human authority.

**Architecture:** Keep a daemon on each machine. The hub alone stores team device-key state, creates challenges and approval descriptors, verifies proofs, and commits high-authority acts. Joiners relay bounded requests over their authenticated node identity; each browser passkey ceremony remains on that machine's configured WebAuthn origin.

**Tech Stack:** Existing `@musterd/protocol` Zod schemas, Node HTTP transport, SQLite authority store, federation node transport, CLI, and browser WebAuthn pages. No new runtime dependency.

**Spec:** [Human authority across a hub and joiner daemons](../specs/2026-10-23-federated-human-authority-design.md)

## Global Constraints

- The hub derives the human, capabilities, node, and expected origin from authenticated state and configured policy, never caller prose or request headers.
- An enrolled node credential proves the machine, not the human. For each actor-bearing relay, the hub resolves the human on its own roster and verifies that the human is already resident on that node (`assertSeatAlreadyResident` or the ADR 728 equivalent) before any side effect.
- Device private keys and human credentials never cross the node channel or appear in logs.
- The hub verifies every high-authority act against current membership, role, key, and revocation state; no cached authorization or bearer grant.
- The relay is a closed set of operations with strict credential-free response schemas. Credential-minting operations and any unsupported result shape stay hub-local and fail on a joiner with `hub_local_required` before mutation (ADR 729).
- Hub-side WebAuthn verification selects exact origin and RP id from configuration keyed by authenticated node id; request headers and caller fields never select them.
- The joiner fails closed for high-authority acts when the hub is unavailable; ordinary local coordination remains available.
- Any `@musterd/protocol` schema change requires an ADR before implementation.
- No new runtime dependency.

## Review Focus

- Forged actor, member, capability, or node fields: derive identity from the authenticated node and hub roster; reject mismatches.
- Replayed, expired, or payload-altered proof: one-use challenge and exact descriptor binding must refuse it.
- A joiner's empty local key table after hub genesis: it must never enter the genesis enrollment path.
- Wrong or attacker-supplied WebAuthn origin: validate against hub-configured origin policy, not `Host` or forwarded headers.
- Hub outage or stale/revoked key: fail closed for authority, while local messages continue and later sync.

## Increments

| Increment | Lane | Deliverable |
| --- | --- | --- |
| 1 | `01M5N54FB29MY34X741MRXAA8P` | ADR 728 fixes the node-authenticated relay contract, challenge and proof ownership, origin checks, failure behavior, and observability. |
| 2 | `01M5N55GVEHPPGVWFERB26K0KN` | Server and protocol implement hub-owned authority state and the ADR 729 credential-free relay allowlist for enrollment, listing, revocation, and supported high-authority operations; adversarial and two-daemon tests cover the review-focus cases. Credential-minting operations remain hub-local. |
| 3 | `01M5N55P48Z932JT19DFFP1NDT` | CLI completes Swetha's enrollment on Air 2 and Nick's countersign on the hub, then uses hub-authoritative high-authority actions from a joiner; update CLI documentation and run the two-machine acceptance flow. |

## Execution Notes

- Increment 2 may add the strict relay protocol schema only after ADR 728 and ADR 729 specify its authority and response boundary.
- Existing local authority endpoints are not blindly proxied. The hub authenticates the enrolled node and derives the human actor independently before any protected write.
- The older blocked Secure Enclave helper lane and the active ADR 662 follow-through lane overlap authority files; coordinate their scope before editing shared paths.
- No implementation begins until the design lane is merged and ADR 728 is published as a draft PR with its number reservation, per `AGENTS.md` and ADR 223.

