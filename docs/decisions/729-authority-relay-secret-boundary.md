# 729 — Authority relay credential boundary

- Status: accepted
- Date: 2026-10-23
- Lane: `01M5N55GVEHPPGVWFERB26K0KN` (goal `federated-human-authority`)
- Builds on: [ADR 728](728-hub-owned-human-authority.md), [ADR 662](662-one-machine-per-hosted-seat.md)

## Context

ADR 728 makes the hub the sole authority for human device keys, A2 proofs, and high-authority
writes. A joiner reaches that authority over its enrolled node channel. The existing local routes
are not uniform in what they return: some return only operation results, while others mint a
one-time connect link, a grant, a seat token, or a human credential. Forwarding every route through
one relay would therefore turn a machine credential into a path for bearer-secret delivery.

The approved implementation plan keeps two daemons and the hub-owned authority model. Nick's
approval of the blocking deviation ask narrows this increment: operations that return credentials
stay hub-local; the relay carries only a fixed set of credential-free results.

## Problem

A general HTTP proxy or a loosely typed relay operation can expose future or existing credential
responses over the node channel. Filtering response JSON after the operation is unsafe: the secret
may already have been minted, logged, or returned in a differently named field, and a successful
write followed by a rejected response leaves callers uncertain whether it happened.

The relay must preserve ADR 728's single hub authority while making the boundary structural: only
named operations with strict request and response schemas may cross it, and a credential-bearing
operation must be refused before it mutates state.

## Decision

1. **No generic proxy.** The protocol defines a closed discriminator for authority relay
   operations. It carries an operation name and that operation's strict, bounded payload; it has no
   caller-selected HTTP method, path, header, or response type. Unknown operations and malformed
   requests fail closed.

2. **The initial relay set has credential-free response schemas.** It includes device-key listing,
   enrollment challenge creation, passkey and raw public-key enrollment, key revocation, descriptor
   creation and retrieval, proof presentation and retrieval, and these high-authority writes: lane acceptance or
   decline, a lane's `authorized_by` attestation, member removal, member ceiling changes, and team
   archive. Each operation has a strict result schema that contains no minted credential. The
   relay does not include `POST /members` (returns seat and human credentials), sponsored agent
   creation (returns a one-time connect link), grant issuance, bootstrap or human credential mint
   and rotation, or request approval paths that return grants. Team policy writes are also excluded
   because policy values may contain secret-bearing URLs or tokens. Add an operation only after its
   response has an explicit credential-free schema and the negative test proves no credential can
   appear in it.

3. **Credential minting remains hub-local.** A joiner refuses a credential-bearing or otherwise
   unsupported authority operation with a stable `hub_local_required` refusal before any local
   write or mint. The caller must run that operation on a Surface attached to the hub. There is no
   local fallback, queued mint, or post-hoc secret scrub. Credentials include `mskey_`, `msgr_`,
   `mscr_`, `msac_`, invite codes, connect links, and equivalent one-time bearer values.

4. **One-use ceremony material is distinct from credentials.** A WebAuthn challenge, an approval
   descriptor nonce, and a signed proof may cross the authenticated node channel only for their
   named ceremony or operation. They are short-lived, one-use, bound to the Team, actor, operation,
   payload and authenticated node as required by ADR 728; they are never treated as a bearer grant,
   persisted on the joiner, or written to logs. Public key material and credential metadata may
   cross; private keys and human credentials never do.

5. **The hub still re-derives authority.** The hub authenticates the node credential, resolves the
   human from its own Team roster, checks current standing, kind, capabilities and residence on
   that node, then verifies the fresh A2 proof and performs the operation. Caller-supplied node,
   role, capability, origin, or authorization-result fields cannot override hub state. The node
   credential proves only the machine.

6. **The boundary is regression-tested.** Every relayed operation is checked against its request
   and response schema. Tests prove that unsupported and credential-bearing operations make no
   mutation on either daemon, that no credential-shaped response can pass a relay result schema,
   and that an allowed action is written once by the hub and becomes visible through normal sync.

## Consequences

- **2026-10-23 implementation note:** a human lane-review answer from a joiner is forwarded as the
  closed `lane.answer` operation. The hub reconstructs the envelope from the stored ask and bounded
  reply fields, then runs the existing message route with A2 bound to the authenticated node. The
  joiner does not apply the verdict locally; the hub's message and lane state return through normal
  sync. The strict result carries the ack and lane-review outcome fields only.
- Enrolling and managing device keys, completing supported passkey ceremonies, and using the
  listed credential-free high-authority actions can originate on a joiner while the hub remains
  the sole decision-maker.
- Creating members, agents, grants, invites, bootstrap credentials, human credentials, and other
  bearer values must be done from a Surface attached to the hub. The relay reports this explicitly
  before an operation begins.
- The protocol change is intentionally narrower than an authority API proxy. Future actions require
  an ADR or an amendment to this decision if they widen the operation set, and must keep response
  schemas credential-free.
- No runtime dependency is added.

Follows-up: 01M5N55GVEHPPGVWFERB26K0KN
Follows-up: 01M5N55P48Z932JT19DFFP1NDT

## Observability & Evaluation

- **Traces:** record relay operation name, authenticated node id, actor, outcome and refusal code.
  Exclude node credentials, challenges, descriptor nonces, signatures, proofs, and all bearer
  credentials from logs and audit details. Count `hub_local_required` refusals without recording
  request bodies.
- **Eval:** per-operation protocol tests reject unknown discriminators, extra request fields,
  credential-shaped result fields, oversized payloads and invalid response variants. Two-daemon
  tests verify allowed operations mutate only hub state, fail closed when the hub is unreachable,
  and leave both daemons unchanged for excluded credential-minting operations. The baseline is the
  existing single-daemon ADR 662 authority test set; the success measure is identical A2 decisions
  with no relay result containing a bearer credential.
- **Experiment:** complete Swetha's first-key enrollment on Air 2 with Nick's countersign at the
  hub, then perform one allowed high-authority action from Air 2 and one excluded credential mint.
  The experiment falsifies this decision if the joiner can mint or receive a bearer credential, a
  joiner-local authority row decides an action, or an allowed action succeeds without fresh hub
  verification.
