# 769 — An admin vouches for a first passkey from /live

- Status: proposed
- Date: 2026-10-29

## Context

Past team genesis, a human with no active key cannot enroll a passkey alone. Another human admin
with a standing key must countersign: they sign `device_key_admin` over
`{action: 'enroll', kind: 'passkey', member}` (ADR 662, ADR 728 §4). The rule exists because the
server cannot tell a real authenticator from a fabricated registration. Once a team has keys, the
admin's countersign is the anchor and the ceremony is not (ADR 662 Consequences, 2026-10-20).

Today the countersign takes three terminal steps and a hand-copied proof:

1. The member runs `musterd authority enroll --confirmed-by <admin>`, which prints what the admin
   should run.
2. The admin runs `musterd authority approve --act device_key_admin --target <member> --payload …`
   on the hub, which prints the proof JSON.
3. The member pastes that proof into `--countersign-proof`.

ADR 767 moved every other enrollment case into /live. This is the one left (lane 01M64SXW85).

## Problem

Carrying the countersign in /live is easy to wire, because every route it needs already exists. The
hard part is that the countersign is the anchor. An admin who taps "vouch" on a request that came
from a stolen browser session has enrolled an attacker's key for that member. The admin's screen
has to make "this really is them asking" a deliberate check, not a reflex.

## Decision

Proposed, revised 2026-10-29 after big-body's security read. Pending slippy's design and a second
security read. Nothing is built yet.

The read found two gaps in the first proposal. The countersign payload named the member but not the
key, so a parked proof would enroll any registration for that member until it expired. And a check
code shared by both screens proves they show the same request, not who started it. So the vouch now
signs the exact key, and the code is described as a same-request check only.

1. **The member enrolls first, and the daemon holds the key.** Past genesis, the member's ADR 767
   ceremony runs as before. `enrollPasskeyGuarded` verifies the registration, then refuses with
   `countersign_required` as it does today. It now also records the verified key against the
   enrollment code (new columns on `enrollment_codes`: the public key, the credential id and the
   key digest, sha256 of the SPKI). It returns the digest in the refusal. The code expires in ten
   minutes as it does now, and the held key expires with it. Nothing is enrolled.
2. **The member asks.** The sheet says "an admin must vouch for this passkey" and lists the team's
   human admins with a standing key. Picking one sends a `request_help` to that admin carrying
   `{vouch: {member, key_digest}}`. Both screens show a **check code**: six digits taken from the
   digest.
3. **The admin vouches.** The admin's /live shows the request under Waiting for you: who is asking
   and the check code. The card says "this code only shows you're looking at the same request.
   Before you vouch, confirm on a call or in person that <member> started it". **Vouch with
   passkey** makes the admin's browser create its own descriptor (`device_key_admin`, target the
   member, payload `{action: 'enroll', kind: 'passkey', member, key: <digest>}`) and sign it. A new
   route, `POST /authority/passkeys/vouch {member, key_digest, approval}`, then completes the
   enrollment. It verifies the admin's proof through `requireAuthority`, re-runs the countersign
   rules (a different human admin with a standing key and current admin capability), finds the held
   key whose digest matches, and in one statement spends the code and enrolls the key. Because the
   admin mints the descriptor when they act, the request lasts as long as the code (ten minutes),
   not the five-minute descriptor.
4. **The member sees it land.** The member's sheet polls its own keys and shows "<admin> vouched,
   your passkey is enrolled". The member does not click again, because the key was created in step 1.

Guard changes, which fail closed:

- The countersign payload must include `key`, and it must equal the digest of the verified
  registration. A countersign without `key` is refused. This covers the existing
  `POST /authority/passkeys` countersign path and the authority relay as well.
- The terminal path follows the same order: `musterd authority enroll --confirmed-by <admin>` runs
  the ceremony first, then prints the `musterd authority approve … --payload` line with the key
  digest, and the admin's approve finishes it via the vouch route. `--countersign-proof` is
  retired.
- Wrong member, wrong admin, a digest with no held key, an expired code and a replayed proof each
  fail with their own reason. Two concurrent vouches enroll at most one key.

**Joiners.** ADR 728 §4 and §9 serve the countersign from the hub's origin. An admin vouching from
a joiner's /live would be refused, so the card says so and links to the hub's /live.

## Consequences

To be written once the open questions are settled.

## Observability & Evaluation

- **Traces:** the existing `device_key.enrolled` audit row (actor the member) and the countersign
  verification inside `enrollPasskeyGuarded`. The request itself is a `request_help` act.
- **Eval:** to be set with the design.
- **Experiment:** n/a — a consent ceremony, not a tunable.
