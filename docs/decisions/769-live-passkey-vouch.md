# 769 — An admin vouches for a first passkey from /live

- Status: accepted
- Date: 2026-10-29 (revised 2026-11-06)
- Lane: `01M64SXW85VJ064EQCN67AY34V`
- Reviews: big-body (security, 2026-10-29 and 2026-11-06), slippy (design, 2026-11-06)
- Relates to: ADR 662, ADR 728, ADR 767, ADR 808, ADR 812

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

Revised 2026-10-29 after big-body's first security read, and 2026-11-06 against ADRs 808 and 812,
then after slippy's design read and big-body's second security read the same day. The build waits on
fifty's passkey fixes (lanes 01M6Q3ZJJB, 01M6Q1RDTK, 01M6Q1QMTF), which own the same files.

The first read found two gaps. The countersign payload named the member but not the key, so a
parked proof would enroll any registration for that member until it expired. And a check code shared
by both screens proves they show the same request, not who started it. The second read found that
the key digest alone does not pin the rest of the held registration, and that a code taken from the
ask body is not bound to what the phone signs. So the vouch signs a digest of the whole held
enrollment, and the admin must type a code the member reads them.

### The flow

1. **The member enrolls first, and the daemon holds the registration.** Past genesis, with no usable
   key (see "Who is sent here"), the member's ADR 767 ceremony runs as before.
   `enrollPasskeyGuarded` verifies the registration, then refuses with `countersign_required` as it
   does today. It now also writes a **held enrollment** against the enrollment code: team, member,
   the code's challenge hash, credential id, SPKI, the registration's `origin` and `rp_id`, and the
   **enrollment digest**, sha256 over the canonical JSON of exactly those fields (the same
   canonicalisation as the approval descriptor). The row is written once and never updated, and it
   expires with the code (ten minutes). The refusal returns the enrollment digest. Nothing is
   enrolled. The registration options are the ones fifty's lane 01M6Q3ZJJB ships (a per-credential
   user handle and `excludeCredentials`), so holding a registration never overwrites a credential
   the authenticator already has.
2. **The member asks.** The sheet says "an admin must vouch for this passkey" and lists the human
   admins whom `recoveryCountersignerStands` would accept: a different human, admin now, holding a
   key that signs somewhere the hub serves. An admin with only dead-origin passkeys is not listed,
   because their vouch could not be signed. When nobody is listed, the sheet does not dead-end: it
   says nobody on the team can vouch and names the ADR 808 inc D recovery code ("ask whoever runs
   the hub machine"). Picking an admin sends a `request_help` to that admin carrying
   `{vouch: {member, enrollment_digest}}`. The member's sheet shows the **check code**: six digits
   derived from the enrollment digest by one function in `@musterd/protocol`
   (`vouchCheckCode(digest)`). The sheet also names the member's keys that do not sign here, read
   only: "Your 2 passkeys from <origin> don't sign here. This new one will", with each key's label
   and created date.
3. **The admin vouches, on /live.** The request lands only on /live, under Waiting for you. The
   request_help notifies as any act does, but the notification links to the card and carries no
   vouch control: a lock-screen approve is the reflex this ADR exists to prevent. The card names the
   member, says how many of their keys don't sign here, and does **not** show the check code. It
   asks "Call <member> or ask in person, and enter the 6-digit code they read you", and Vouch stays
   disabled until the typed code equals `vouchCheckCode` of the request's digest. The typed code is
   the out-of-band identity check made a required step. It also proves both screens show the same
   request. Then:
   - **Vouch with passkey:** the admin's browser mints its own descriptor (`device_key_admin`,
     target the member, payload `{action: 'enroll', kind: 'passkey', member, key: <enrollment
     digest>}`) and signs it.
   - **Vouch from your phone,** offered when no passkey of the admin's signs on this origin but
     their phone key stands: after the code matches on /live, the same descriptor goes to the phone
     through the ADR 808 inc C app-channel ask. The phone words it from the signed payload, never
     from the ask body (see "Fixed words on the phone").

   A new route, `POST /authority/passkeys/vouch {member, enrollment_digest, approval}`, completes
   the enrollment (see "Commit"). Because the admin mints the descriptor when they act, the request
   lasts as long as the code (ten minutes), not the five-minute descriptor.
4. **The member sees it land.** The member's sheet polls its own keys and shows "<admin> vouched,
   your passkey is enrolled". The member does not click again: the registration was made in step 1.
   The dead keys from step 2 are listed again with one **Revoke these** action, nothing
   pre-selected, dismissible. The new key signs the revoke (ADR 808 §3), so no second countersign is
   needed. Nothing is revoked automatically, because revocation cannot be undone and the old
   hostname may come back. Whatever the member chooses, those keys keep a "doesn't sign here" badge
   in the keys list.

**Joiners.** ADR 728 §4 and §9 serve the countersign from the hub's origin. On a joiner's /live the
card's whole content is a link to the hub's /live; it never offers Vouch and then refuses.

### Who is sent here

The countersign branch of `enrollPasskeyGuarded` opens when **no usable key** of the member's
stands, not only when they hold zero active keys. "Usable" is ADR 808's `usableKeyStands` over the
**hub's configured passkey hostnames**, never the current page's host. A phone key, a platform key,
or a passkey whose recorded `rp_id` is any configured hostname keeps the member on the standing-key
approval. Vouching is never enabled just because the page in front of them cannot sign.

Two parts of this are stated as trades, not facts:

- **A passkey with no recorded `rp_id`** (made before ADR 808 inc A) counts as unusable, as it does
  for the inc D recovery code. That is a recovery policy, not proof the key is dead: it may still
  sign on an origin the hub serves. The member's sheet and the admin's card list such keys as
  "made before origins were recorded", so the admin sees them before vouching.
- **It widens who can authorize an enrollment.** Today an admin's countersign is read only at zero
  keys. After this, it also enrolls a key for a member who holds active keys the hub cannot match to
  a configured origin. The authority is the same as for a first key (a different human admin's
  standing key, plus the typed check code), and the case it serves had no path in at all: the
  standing-key approval cannot be signed, and the recovery code is refused with
  `countersigner_stands`.

### Commit

`POST /authority/passkeys/vouch` runs one transaction, and every check runs inside it at commit
time:

- the admin's proof verifies through `requireAuthority` over the key-bound payload, with the
  origin and node checks it applies today, the same on the authority relay;
- the admin is a different human, admin at this moment, whose signing key `usableKeyStands`
  accepts and is not revoked;
- the member still has no usable key (the predicate above, re-run);
- the enrollment code is unspent and unexpired, and its held enrollment's recomputed digest equals
  both the request's and the signed `key`.

Then it spends the code and inserts the key in the same transaction. A failed insert rolls the spend
back, and the code stays usable until it expires. A second vouch, a retry or a replayed proof finds
the code spent and fails with its own reason, so two concurrent vouches enroll at most one key.

Guard changes, which fail closed:

- A countersign must carry `key`, equal to the held enrollment's digest. A countersign without
  `key`, or with the payload of the standing-key approval (`{action, kind}` only), is refused. A
  generic `device_key_admin` proof cannot stand in for the key-bound one, because the payload digest
  differs. This covers the existing `POST /authority/passkeys` countersign path and the relay too.
- The terminal path follows the same order: `musterd authority enroll --confirmed-by <admin>` runs
  the ceremony first and prints the `musterd authority approve … --payload` line with the enrollment
  digest. The admin's approve finishes it through the vouch route, after the CLI asks for the check
  code the member reads them. `--countersign-proof` is retired.
- Wrong member, wrong admin, an admin no longer admin or whose key was revoked, a digest with no
  held enrollment, an altered record, an expired code and a replayed proof each fail with their own
  reason.

### Fixed words on the phone

The ask body is daemon-written text that the phone labels as the asker's words. Nothing in it is
trusted. This ADR extends ADR 812's fixed wording for one payload shape: `device_key_admin` over
`{action: 'enroll', kind: 'passkey', member, key}`, where `member` equals the target and `key` is a
64-hex digest. For that shape the phone shows the headline "Add a new passkey for <member>", the
check code computed **on the phone** by `vouchCheckCode(key)` from the payload it is about to sign,
and the same fixed instruction as /live: "Only approve if <member> read you this code on a call or
in person." Any other value in either field falls back to ADR 812's generic line. The code on the
phone is a second look at what is signed, not the gate: the gate is the typed code on /live.

This is a change to `@musterd/protocol` (`vouchCheckCode`, one more branch in `approvalWording`), so
this ADR is its record under hard rule 1. No schema, signing-byte or digest change.

## Consequences

- One new table or column set for held enrollments, one new route, one protocol helper, and the
  admin card, the member's sheet and the phone wording. The terminal countersign changes shape and
  `--countersign-proof` goes.
- Every member with a reachable countersigner gets in from /live, including after an origin move
  with only passkeys. ADR 808 inc D stays the path for a team with nobody left who can vouch.
- An admin can now enroll a key for a member who still holds keys the hub cannot place (stated
  above). The typed check code and the commit-time re-checks are what stand against a stolen
  browser session asking in the member's name.
- An admin who cannot reach the member by call or in person cannot vouch. That is intended.
- The build needs fifty's three passkey fixes first. The lane's scope widens to the code files
  once they land.

**2026-11-06: increment 1, protocol (lane `01M64SXW85`).** `vouchCheckCode(digest)` and the
`check {code, instruction}` field on `approvalWording` land first, because the server, /live and the
phone all build on them. fifty's three passkey fixes have landed (#3956, #3966, #3967, then #3972),
so the server increment follows. Showing `check` on the phone is a mobile follow-up. That follow-up
also adds a vouch vector to `approval.vectors.json`, which holds only the phone key's public half
today, so no new signed vector can join it without a fresh vector key.

## Observability & Evaluation

- **Traces:** the existing `device_key.enrolled` audit row (actor the member) and the countersign
  verification inside `enrollPasskeyGuarded`. The request itself is a `request_help` act.
- **Eval:** the falsifiers are tests that must exist before the build lane merges: a member with a
  usable key on another configured origin, a phone key or a platform key is sent to the standing-key
  approval, never the vouch; a key with null `rp_id` is listed as unrecorded on both screens; an
  altered body, code, held record or digest is refused; a revoked admin key, an admin demoted
  mid-request, an expired code and a replayed proof are refused; two simultaneous vouches enroll
  one key; a failed insert leaves the code unspent; a generic `device_key_admin` proof is refused as
  a countersign. In use: any `device_key.enrolled` row through the vouch route that was not preceded
  by a matching typed-code check on the admin's /live is a defect.
- **Experiment:** n/a — a consent ceremony, not a tunable.
