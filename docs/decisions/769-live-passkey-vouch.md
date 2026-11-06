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

ADR 808 (accepted 2026-11-05, after the first draft of this ADR) changed what "standing key" means
in practice. A key now records the origin and relying-party id it was made on, and a passkey whose
`rp_id` is not a hostname the hub serves cannot sign here. `usableKeyStands` and
`recoveryCountersignerStands` in `store/authority.ts` are that predicate. ADR 808 inc C lets a
human's own phone approve a new passkey, and inc D gives a team with **nobody left who can vouch** a
one-time recovery code minted on the hub's loopback. The recovery code is refused with
`countersigner_stands` whenever another human admin holds a key that signs here, and points the
member back to the countersign. That makes this ADR the path for every member who has a
countersigner, and inc D the path for the rest. ADR 812 fixed the words for a `device_key_admin`
enrollment descriptor: `{action:'enroll', kind:'passkey'}` reads "Add a new passkey for <target>",
and extra fields such as `member` and `key` leave that headline unchanged.

## Problem

Carrying the countersign in /live is easy to wire, because every route it needs already exists. The
hard part is that the countersign is the anchor. An admin who taps "vouch" on a request that came
from a stolen browser session has enrolled an attacker's key for that member. The admin's screen
has to make "this really is them asking" a deliberate check, not a reflex.

## Decision

Proposed, revised 2026-10-29 after big-body's security read and again 2026-11-06 against ADRs 808
and 812. Pending slippy's design and a second security read. Nothing is built yet, and the build
waits on fifty's passkey fixes (lanes 01M6Q3ZJJB, 01M6Q1RDTK, 01M6Q1QMTF), which own the same files.

The read found two gaps in the first proposal. The countersign payload named the member but not the
key, so a parked proof would enroll any registration for that member until it expired. And a check
code shared by both screens proves they show the same request, not who started it. So the vouch now
signs the exact key, and the code is described as a same-request check only.

1. **The member enrolls first, and the daemon holds the key.** Past genesis, the member's ADR 767
   ceremony runs as before. `enrollPasskeyGuarded` verifies the registration, then refuses with
   `countersign_required` as it does today. It now also records the verified key against the
   enrollment code (new columns on `enrollment_codes`: the public key, the credential id and the
   key digest, sha256 of the SPKI). It returns the digest in the refusal. The code expires in ten
   minutes as it does now, and the held key expires with it. Nothing is enrolled. The registration
   options are the ones fifty's lane 01M6Q3ZJJB ships (a per-credential user handle and
   `excludeCredentials`), so holding a key never overwrites one the authenticator already has.
2. **The member asks.** The sheet says "an admin must vouch for this passkey" and lists the team's
   human admins whom `recoveryCountersignerStands` would accept: a different human, admin now, with
   a key that signs where the hub serves (a phone key, a platform key, or a passkey whose recorded
   `rp_id` is a configured hostname). An admin whose only passkeys are from an origin the hub no
   longer serves is not listed, because their vouch could not be signed. When the list is empty, the
   sheet does not dead-end: it says nobody on the team can vouch and names the ADR 808 inc D
   recovery code ("ask whoever runs the hub machine"). Picking an admin sends a `request_help` to
   that admin carrying `{vouch: {member, key_digest}}`. Both screens show a **check code**: six
   digits taken from the digest.
3. **The admin vouches.** The admin's /live shows the request under Waiting for you: who is asking
   and the check code. The card says "this code only shows you're looking at the same request.
   Before you vouch, confirm on a call or in person that <member> started it". **Vouch with
   passkey** makes the admin's browser create its own descriptor (`device_key_admin`, target the
   member, payload `{action: 'enroll', kind: 'passkey', member, key: <digest>}`) and sign it. When
   no passkey of the admin's signs on this origin but their phone key stands, the card offers
   **Vouch from your phone** instead: the same descriptor goes to the admin's phone through the
   ADR 808 inc C app-channel ask, whose fixed headline (ADR 812) reads "Add a new passkey for
   <member>". The daemon-written ask body carries the check code, so the phone shows it under the
   rule as the asker's words. A new
   route, `POST /authority/passkeys/vouch {member, key_digest, approval}`, then completes the
   enrollment. It verifies the admin's proof through `requireAuthority`, re-runs the countersign
   rules (a different human, admin at this moment, whose signing key is one `usableKeyStands`
   accepts), finds the held
   key whose digest matches, and in one statement spends the code and enrolls the key. Because the
   admin mints the descriptor when they act, the request lasts as long as the code (ten minutes),
   not the five-minute descriptor.
4. **The member sees it land.** The member's sheet polls its own keys and shows "<admin> vouched,
   your passkey is enrolled". The member does not click again, because the key was created in step 1.

Guard changes, which fail closed:

- The countersign branch of `enrollPasskeyGuarded` opens when **no usable key** of the member's
  stands (ADR 808's predicate), not only when they have zero active keys. Today a member whose
  passkeys are all bound to a dead origin, on a team that has another admin, has no path in: they
  cannot sign the standing-key approval, the recovery code is refused with `countersigner_stands`,
  and the countersign is only read at zero keys. The admin's countersign is the same authority as
  for a first key, so this widens no one's reach. The dead keys stay listed until revoked, and the
  vouch card says the member's existing keys do not sign here.

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

## Open questions

For slippy (design):

- Where the request lands on the admin's side: Waiting for you on /live, the phone, or both.
- Whether the member's sheet should name the dead keys it is replacing, and offer to revoke them
  once the vouch lands (ADR 808 §3).

For the second security read:

- The countersign branch opening at "no usable key" instead of "zero keys" (Guard changes, first
  item). Is there a case where a member with a live key on another origin the hub serves should be
  sent to the standing-key approval instead?
- The phone vouch. Is the ADR 812 headline plus an ask body holding the check code enough for an
  admin to know whose key they are adding, given the body is labelled as the asker's words?

## Consequences

To be written once the open questions are settled.

## Observability & Evaluation

- **Traces:** the existing `device_key.enrolled` audit row (actor the member) and the countersign
  verification inside `enrollPasskeyGuarded`. The request itself is a `request_help` act.
- **Eval:** to be set with the design.
- **Experiment:** n/a — a consent ceremony, not a tunable.
