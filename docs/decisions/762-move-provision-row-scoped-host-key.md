# 762 — A host key may finish a move provision pinned to its own label

- Status: accepted
- Date: 2026-10-29

## Context

Air 2 is going back to other work, and the hub laptop cannot host its seats, so a rented Linux VM
(`musterd-joiner-1`) joins the team as a second machine (lane `01M64AYDSZ`). Its seats arrive by
`musterd move <seat> --to musterd-joiner-1` (ADR 696): the hub re-binds the seat and writes a
`kind: 'move'` provision pinned to the target's host label (ADR 703), and the target's host stands
the Workspace up from that row.

On 2026-10-29 the first move, ryder (an unsponsored claude-code seat), stalled. Three paths
were tried, and each was refused:

1. Run on the joiner as the admin, `musterd move ryder --harness claude-code` was refused:
   "member creation returns or carries team authority and must be performed on a Surface attached to
   the hub". The joiner authority relay (ADRs 728/729) deliberately excludes credential-bearing work.
2. The joiner's host polled with a host key nick minted on the hub. That key replicates to the
   joiner sponsor-only (ADR 689 d2), and `hostMayServe` refuses an unsponsored seat, so the claim
   list stayed empty.
3. Pointed at the hub, where an admin's key is team-wide, the host claimed the row. It then failed
   at the credential step: `authProvisionCaller` requires `assertSponsorOf` against the key's
   creator, and ryder is sponsored by nobody.

## Problem

A move is already authorized when the hub writes the row: ADR 696 lets only an admin, the seat's
sponsor or the seat itself move a seat. But no path lets the target machine finish an authorized
move of an unsponsored seat. A sponsor-scoped host key reaches only its creator's sponsored seats,
and widening its scope, or relaying a member credential to the joiner, would hand a machine far
more authority than one move needs. big-body named the bound (act `01M64JBJ9E`): row-scoped
authority, no general relay, no broader key scope, no team or member bearer credential.

## Decision

1. **The row is the authority.** A host key may serve a seat its creator does not sponsor only
   through a `kind: 'move'` provision that is pinned to the key's own label (`row.host` equals the
   key's `target`) and authored by the key's creator (`row.sponsor_id` equals `created_by`).
2. **Claim.** `claimProvisions` accepts such a row even where `hostMayServe` would refuse the seat
   (`moveRowServes`). A row pinned to another label, authored by someone else, or of kind `mint`
   is left as before.
3. **Finish.** `authProvisionCaller` keeps `assertSponsorOf` first. Only when that refuses with
   `forbidden` does it accept `assertMoverOf`: the same live-agent and live-creator checks, plus
   a **claimed** move row for that seat, claimed by and pinned to the key's label, and authored by
   the creator. This covers the four provisioning verbs it already gates: the `claim_seat`
   credential, the seat grant, enrolment under the key's own label, and credential cleanup.
4. **Nothing else widens.** Mint rows keep the sponsor check. No relay is added, and no member or
   team bearer leaves the hub. A key's team-wide or sponsor scope is unchanged for wake leases and
   every other route.

## Consequences

- An admin's move of any agent to a machine that holds the admin's host key for that label can
  finish on that machine. The seat gets a fresh `claim_seat` credential minted on the hub. The
  machine never holds the admin's credential.
- At a joiner, the host-key `claim_seat` mint is relayed, and the hub fold re-checks sponsorship
  (ADR 689 d6). That fold is not changed here, so a moving host finishes **against the hub**: on
  `musterd-joiner-1` the host runs `--cloud-provision --server <hub>`.
  Follows-up: teach `answerCredentialRequest` the same move-row check, so a joiner-local host can
  finish a move without dialing the hub (lane `01M64AYDSZ`).
- Existing behaviour changes in one place: a sponsor-scoped key now claims a move row it authored
  for a seat it does not sponsor. `hostProvisions.test.ts` pins this, and still pins that another
  sponsor's key does not.

## Observability & Evaluation

- **Traces:** the provisioning verbs already write audit rows with `via: 'host_key'` and the
  label. A move finished under this ADR is the claimed move row's id, joined to those rows.
- **Eval:** `move-provision-host-key-http.test.ts` covers five cases: a claimed pinned row
  finishes; an unclaimed row, another label, another seat, and a mint row are each refused.
- **Experiment:** the live check is the three moves to `musterd-joiner-1` (ryder, sloane,
  gptbot) reaching `ready` and each seat answering a steer from the VM. Falsify: a move row that
  reaches `ready` on a label it was not pinned to, or a host key that mints for a seat with no
  claimed move row.
