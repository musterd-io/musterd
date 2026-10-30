# 775 — Rotation retires the predecessor bootstrap credential

- Status: accepted
- Date: 2026-10-30

## Context

[ADR 344](./344-scoped-rotatable-agent-bootstrap-credentials.md) §5–6 made bootstrap-credential
rotation a staged, manual move. Minting a same-scope successor flips the predecessor to `rotated`,
and both keys keep authenticating "until the admin revokes it". An administrator is expected to
verify the successor and then revoke the predecessor or give it an expiry. The Consequences
section called the overlap "temporary dual authority … so the administrator must verify and
revoke promptly".

That second step was left to discipline, and nobody did it. `findBootstrapCredential`
(`packages/server/src/store/teams.ts`) matches `state IN ('active', 'rotated')` with no time
bound. Most rows carry `expires_at` NULL, so a rotated key authenticates forever.

Lane 01M3W42669 measured this on revive on 2026-10-29. Rotating big-body's secrets after they
were exposed in a session transcript on 2026-10-01 turned up three claim keys for big-body and
thirteen `mac.lan` host keys that were still live, all issued before the exposure and all in
`rotated` state. nick revoked them by hand. On the same day the inventory still held live
rotated rows for ryder, ghost, lazara, sloane, gptbot, wallow, alfie, cloud-delta-2 and
`mac.lan`.

On a joiner it is worse. The [ADR 689](./689-sponsor-scoped-credentials-replicate-to-joiners.md)
fold projects every hub-minted key as `active` and projects only `credential.accepted` and
`credential.revoked`. A hub rotation therefore never reaches the joiner: there the predecessor
stays fully `active`, not even marked rotated.

## Problem

A rotation must end the predecessor's authority on its own, without an admin step. It must still
leave the staged move ADR 344 wanted, where a successor is carried to its Workspace before the
old key stops working. The rule must hold on the hub and on every joiner.

## Decision

1. **A rotated predecessor authenticates only within a fixed grace window of its rotation.**
   `ROTATION_GRACE_MS` is 1 hour. `findBootstrapCredential` resolves a row when it is `active`,
   or when it is `rotated` with `rotated_at` inside the window. Past the window the key fails
   closed on every path that resolves through that function: HTTP and WS claim, host
   wake-lease, provisioning, and revocation by a host key. An explicit `expires_at` still
   applies on top of this.
2. **This is a read-time rule, not a migration.** Existing `rotated` rows older than the window
   stop authenticating the moment this ships. Their stored `state` is left as is, so the
   inventory keeps its history, and they can still be revoked to tidy the list.
3. **A joiner follows the hub's rotation.** When the fold projects a hub `credential.accepted`
   for a `host` or `claim_seat` scope, it first marks older projected rows of the same scope
   (`replicated_from` set, `created_at` earlier than the new row) `rotated`, with `rotated_at` set to
   the successor's hub `created_at`: the moment the hub rotated, not the moment this joiner
   happened to pull. The joiner's predecessor then lapses at the same instant as the hub's, and a
   joiner that was offline for a while grants it no extra time. Only older rows are touched, so a
   replayed acceptance never rotates the successor that came after it.
4. **This narrows ADR 344 §6, which is otherwise unchanged.** Revoking at once after verifying a
   successor is still the right move, and still possible. The window only removes the
   failure mode where nobody does it.

One hour rather than the 15 minutes first proposed in the lane: a host successor for a remote
machine (cloud-delta-2, musterd-joiner-1) is carried there by hand over ssh, and 15 minutes cuts
that close. `mint --install` on the same machine needs seconds, so the window costs nothing there.

## Consequences

- When this deploys, every rotated bootstrap key older than an hour stops working. A Workspace
  still presenting one gets the existing bootstrap refusal with its repair command. Every
  rotated row named in Context has a successor that has been in use for days, so no live seat
  is expected to break. If one does, the repair is the usual
  `musterd team bootstrap mint --seat <seat> --install`.
- A successor minted for a remote host has to reach that host within the hour. If it misses,
  the old key is refused and the admin mints again; nothing is lost.
- The seat credential (`msac_`) is not affected: it is a single hash per Member, replaced
  outright on rotation (`mintAgentSeatCredential`), so there is no overlap to close.
- A seat's `rotated` row in the inventory no longer means "still live". The redacted inventory
  could later show a derived `lapsed` state; that is not needed for the fix and is not done
  here.
- `docs/wiki/seat-credential-recovery.md` and `docs/architecture/03-server.md` state the
  window.

## Observability & Evaluation

- Traces: no new event. A lapsed key's refusal goes through the existing bootstrap-refusal path
  and its audit row (`findBootstrapCredentialRecord` is the lifecycle-blind lookup the refusal
  audit already uses), so a refusal caused by the window is visible as a refused claim or host
  call naming a `rotated` credential id.
- Eval: two regression tests. `store.test.ts` resolves a rotated host key at
  `rotated_at + ROTATION_GRACE_MS - 1` and refuses it at `+ ROTATION_GRACE_MS`, while the
  successor still resolves. `sync/credentials.test.ts` 2b rotates a hub host key, round-trips
  to a joiner, and asserts the joiner's projected predecessor is `rotated`, still polls inside
  the window, and is refused past it. Falsifier: either test passing with the `rotated_at`
  bound removed from the query.
- Experiment: after deploy, re-read revive's inventory
  (`GET /teams/revive/agent-bootstrap-credentials`). Each `rotated` row with `rotated_at`
  older than an hour should be refused on a claim. The wake and refresh logs should show no
  seat or host failing on a lapsed key in the first day. A failure there means a Workspace was
  still on a predecessor, and the Consequences line above is wrong.
