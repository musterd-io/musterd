# 767 — /live enrolls a passkey on the daemon's origin

- Status: accepted
- Date: 2026-10-29

## Context

ADR 662 decision 5 puts the passkey surfaces on the daemon's own origin, never the relay, as two
small server-rendered pages: `/authority/passkey`, which `musterd authority enroll` opens, and
`/authority/approve`. The browser has since gained in-page approval. /live signs verdicts, policy
writes and, from ADR 761, a phone's pairing with the human's passkey (`authorityProof.ts`). But
enrolling the passkey in the first place still started in a terminal, so pairing a phone from /live
could dead-end on "run `musterd authority enroll` once". nick asked for no terminal step (lane
01M64QBTZT).

## Problem

Is /live an allowed home for the enrollment ceremony, given that ADR 662 names two pages for it?

## Decision

/live runs the enrollment ceremony itself, under Settings → You → Your passkeys. It is the same
ceremony as the daemon's page, with the same routes and the same rules:

1. `POST /authority/enrollment-challenges` as the signed-in human, returning a one-time challenge
   bound to them.
2. `navigator.credentials.create` with the same parameters the daemon's page uses: user
   verification required, Ed25519 or P-256.
3. `POST /authority/passkeys` with the registration, which the daemon verifies byte for byte as
   before.

The guard decides as it always has. A member's first key at team genesis stands alone. A further
key carries the standing passkey's `device_key_admin` approval over `{action: 'enroll', kind:
'passkey'}`, which /live collects first. A first key past genesis needs an admin countersign, and
/live does not collect one: the daemon refuses it as `countersign_required`, and /live names the
terminal command that does it.

This stays within ADR 662 decision 5's line. /live is served by the daemon from the same origin
(ADR 132), so the ceremony's origin and relying party are the daemon's, exactly as on its own page.
It never runs on the relay. The two server pages stay for the CLI.

## Consequences

- A human whose team is at genesis, or who already holds a passkey, enrolls without a terminal, and
  can then confirm a phone in the same sheet.
- The admin countersign for a first passkey past genesis is still a terminal step. Moving it into
  /live would mean an admin approving on their own sheet for another member, and that is a separate
  decision.
- /live served from an IP literal cannot use passkeys (WebAuthn refuses it), and the panel says to
  open the localhost URL, as the approval path already does.
- No server or protocol change. The enrollment rules have one home, `enrollPasskeyGuarded`.

## Observability & Evaluation

- **Traces:** unchanged. An enrollment from /live writes the same `device_key.enrolled` audit row as
  one from the CLI.
- **Eval:** `passkeyEnroll.test.ts` covers the refusal wording. The ceremony itself is verified by
  the daemon's existing enrollment tests, since the routes are the same.
- **Experiment:** n/a — a surface for an existing ceremony.
