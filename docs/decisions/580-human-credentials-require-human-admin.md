# 580 — Human credentials require a human admin

- Status: accepted
- Date: 2026-10-13

## Context

[ADR 134](134-provisioning-is-localhost-trust-enforced.md) made loopback a checked boundary for
provisioning. That predicate proves the peer is on this machine; it does not identify a human. Agent
seats share that peer boundary. Since then, human credential rotation and the browser's local identity
lookup also used locality as their authority. The `is_admin` clamp in [ADR 172](172-model-family-posture.md)
protects an authenticated actor row, but it cannot protect a route that substitutes loopback for an
actor.

The initial team-create route is different: it creates the team and its first human admin in one
bootstrap operation, before an admin exists. Admin-created invitations are a separate, explicit
delegation; redeeming one does not rely on a local peer or an agent credential.

## Problem

An on-machine agent can use loopback to receive or rotate a human credential, or can cause a human
seat to be provisioned from the roster. That gives the agent the human identity's authority, including
admin when the human seat is an admin. Admin-only controls must prove that the caller is a human admin;
machine locality alone is not that proof.

## Decision

The server MUST distinguish local machine access from human-admin authority.

- `authAdmin` requires an authenticated `human` member whose resolved capabilities include
  `is_admin`. It MUST NOT accept loopback as a substitute.
- Creating or reconciling a human seat, returning its `mscr_` credential, rotating a human
  credential, or returning a human identity credential requires that human-admin authority. A
  file-backed reconcile also requires it when the projection would add or revive a human seat or
  make a human seat admin.
  _(Amended 2026-10-13: the local agent-seat bypass also requires a human admin if reconciliation would change which human seats are admins, including demoting or removing an existing human admin.)_
- Loopback trust MAY bypass member authentication for agent-seat provisioning and agent-seat
  credential rotation. A file-backed projection that would create a human seat or make a human seat
  admin is not an agent-only operation and MUST require a human admin.
  _(Amended 2026-10-13: observers, including agent-kind observers, require a human admin because they can read team traffic.)_
  _(Amended 2026-10-13: a local agent-only reconcile may not demote or remove an existing human admin.)_
- The one bootstrap exception is `POST /teams`: it creates a new team and its first human admin
  together, when that team has no human or prior admin. It does not authorize later human-seat or
  credential operations.
- `GET /local-identity` requires a human-admin credential and returns only that authenticated
  identity. It MUST NOT disclose every credential present in the daemon's local vault to an
  unauthenticated local caller.
  _(Amended 2026-10-13: any authenticated human may retrieve only their own already-held identity; admin authority is not required.)_
- Staging a sign-in handoff requires a human-admin credential. Redeeming its short-lived, single-use
  nonce remains local-peer-only; the nonce is issued only after that authenticated human action and
  transfers that same existing credential without minting a new one.
  _(Amended 2026-10-13: any authenticated human may stage only their own existing credential; agent credentials cannot stage a human identity.)_
- OAuth invitation redemption remains a bounded delegation created by a human-admin-only invite
  operation. OAuth routes MUST NOT treat loopback or an agent credential as proof of human identity.
- Grant inventory and revocation are exposed through `musterd team grant list` and
  `musterd team grant revoke <id>`. Both are human-admin-only, and the list never returns grant
  secrets.

## Consequences

- A local process cannot use the peer-address check alone to obtain or rotate a human credential, add
  a human seat, or gain admin. Agent-seat operations keep the local workflow.
- A local agent cannot change the set of human admins as a side effect of reconciling an agent seat.
- A browser with no stored human credential uses the credential form. Once signed in, it may ask the
  daemon for only that already-held identity; the daemon no longer supplies other identities from its
  local vault.
- The sign-in handoff remains a deliberate transfer of an existing credential after an authenticated
  human action. It does not create a new credential. Ordinary human members retain the one-click
  browser sign-in flow; their authority cannot be used to retrieve or stage another Member's identity.
- Initial team creation remains available before there is an admin; later human authority changes
  use an existing human admin.
- This narrows [ADR 134](134-provisioning-is-localhost-trust-enforced.md)'s local-peer provisioning
  boundary. The dated amendment is recorded there beside the original decision.
- **2026-10-13 — Observer provisioning.** Loopback does not provision observers, including an
  observer whose `kind` is `agent`; full-grade observers can read team traffic. This follows the
  agent-seat-only local shortcut above.

## Observability & Evaluation

- **Traces:** Credential and seat mutations continue to use their existing audit rows; no credential
  or token is added to logs or audit detail. The rotation path records the authenticated human admin
  as the actor.
- **Eval:** Dataset — the credential-route and actor matrix in
  `packages/server/src/transport/humanAuthorityAudit.test.ts`, plus route tests for loopback,
  human-admin, ordinary-human, and session-authenticated-agent callers and the CLI grant-list test.
  Baseline — before this boundary, loopback authority could reach human credential and roster paths;
  the target is zero agent-authorized human credential, human-seat, observer, or human-admin changes.
- **Experiment:** No live probing; deterministic route and CLI regression checks cover the matrix.

## Related

[ADR 134](134-provisioning-is-localhost-trust-enforced.md) (localhost-trust boundary),
[ADR 172](172-model-family-posture.md) (agent admin clamp),
[ADR 170](170-signin-handoff.md) (one-shot local sign-in handoff),
[ADR 450](450-team-invite-join.md) (admin-issued invitation delegation).
