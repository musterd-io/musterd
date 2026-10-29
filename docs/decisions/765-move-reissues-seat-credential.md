# 765 — Finishing a move reissues the seat's credential

- Status: accepted
- Date: 2026-10-29

## Context

ADR 762 let a host key finish a `kind: 'move'` provision pinned to its own label. On 2026-10-29
the first move it carried, ryder to `musterd-joiner-1`, reached `ready`, and ryder woke on the
VM 13 s after a steer. But ryder could not act. Every MCP and CLI call was refused: "a bootstrap
key only claims a seat; routine calls need the seat credential that claim returns."

The cause is the claim route. An agent seat's credential is minted only on its first claim
(`agentAuthorityFor`: `credential_hash === null`). ryder's first claim happened on Air 2 weeks
earlier, so the VM's claim was accepted but returned no credential. The new Workspace held only
the `claim_seat` key, which can claim and do nothing else.

## Problem

A moved seat needs a credential on its new machine, and nothing on the host-provisioning path
produces one for a seat that has claimed before. The admin rotate route
(`/members/:name/agent-seat-credential/rotate`) would work, but it needs an admin bearer that the
VM must never hold (ADR 762 §4).

## Decision

1. When a **host key** mints a `claim_seat` credential, and a claimed move row exists for that
   seat, pinned to and claimed by the key's label and authored by the key's creator
   (`claimedMoveFor`, the ADR 762 authority), the hub clears the seat's `credential_hash` and
   revokes its session leases in the same request.
2. The new machine's claim with that key then mints a fresh seat credential, which is the
   existing first-claim path. The old machine's credential and leases are dead from that moment.
   It happens **once per move row**: the audit row carries `provision: <row id>`, and a later
   `claim_seat` mint under the same row (a retried provision step) finds it and leaves the newly
   minted credential alone.
   That is what a move means (ADR 358 §3: an agent seat lives on one machine).
3. It is audited as `agent_seat_credential.rotated`, with
   `detail: { reason: 'move', via: 'host_key', host, provision, leases_revoked }`. There is no new audit
   action and no protocol change.
4. Nothing else changes. A sponsored mint, an admin or sponsor `claim_seat`, and any `claim_seat`
   without a claimed move row leave the credential as it is.

## Consequences

- A seat moved by host provisioning comes up able to act. Its old Workspace on the source machine
  stops authenticating, so a stray session there fails loudly rather than speaking for the seat
  from two machines.
- A seat whose move reached `ready` before this landed (ryder, 2026-10-29) holds a dead-end
  binding. To recover it, remove its Workspace on the target and move it again, so the host
  provisions afresh.

## Observability & Evaluation

- **Traces:** each reissue is one `agent_seat_credential.rotated` audit row with `reason: 'move'`
  and the host label, next to the `bootstrap_credential.minted` row (`via: 'host_key'`).
- **Eval:** `move-provision-host-key-http.test.ts` covers the reissue for a claimed move row, and
  checks that a retried mint under the same row and an admin's direct `claim_seat` both leave the credential untouched.
- **Experiment:** a moved seat (ryder, then sloane and gptbot) answers a steer from
  `musterd-joiner-1` with its own MCP tools. Falsify: a seat moved under this ADR whose first
  routine call after the claim is refused for want of a seat credential.
