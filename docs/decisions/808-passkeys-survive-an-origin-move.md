# 808 — Passkeys survive an origin move

- Status: accepted
- Date: 2026-11-05

## Context

A passkey is bound by the browser to a relying-party id, the hostname of the page that made it
(ADR 662 decision 5). musterd's `device_keys` row keeps the public key, the kind and the dates, and
nothing about where the key was made. Every surface that lists a human's keys (`GET
/authority/keys`, /live's "Your passkeys", `musterd authority keys`) therefore shows every key as
equal, and the guard that asks a standing key to approve the next enrollment or a revocation (ADR
662 decision 6, ADR 767) has no way to know that none of them can answer on this origin.

On 2026-11-04 the revive hub moved from nick's laptop to a box (ADR 796, lane 01M6HWVD5J) and /live
moved with it, from `http://localhost:4849` to `https://musterd-joiner-1.tail400343.ts.net`. nick's
two passkeys were `rp_id localhost`. On the new origin the settings page listed both as if they
worked; "Add a passkey" started the approval ceremony first and the browser, finding no matching
credential, offered a QR code with no explanation; the page has no revoke control; and the
zero-key recovery path needs a second human admin, which the team does not have. What got him
through was that the approval and the registration are two nonce-joined steps that may come from
different configured origins: the laptop daemon was stopped to free its port, an ssh tunnel put the
hub on `localhost:4849`, the approval was signed there and the registration ran on the HTTPS host,
with a terminal command that had to stay running (it was stopped once, and the approval was lost),
and three more terminal commands revoked the old keys. nick's words afterwards: "that was a
horrendous user experience." The runbook keeps the procedure
(`docs/guides/hub-relocation.md`); this ADR is about never needing it again.

## Problem

An origin move is a normal event (a hub relocation, a new HTTPS name, musterd Cloud), and after one
a human's standing passkeys are silently useless on the surface they are shown on. How does a
member keep approving, and recover when nothing they hold can sign here, without a terminal and
without a second admin?

## Decision

1. **A device key records where it was made.** `device_keys` gains `origin` and `rp_id`, filled at
   enrollment from the registration's client data (for a passkey) or `app` (for a phone key). Rows
   from before carry null, which every reader renders as "made before this was recorded". The keys
   list carries both, on every transport.

2. **The surface says which keys sign here.** /live compares each passkey's `rp_id` with the
   page's hostname. A key that does not match is listed as unusable here, with the origin it was
   made on. The phone keys are listed as signing from the phone. The "Add a passkey" control reads
   the same facts: when no active passkey matches this origin, it says so and names where one does
   (another origin, or the phone) before any ceremony starts. The browser's QR fallback is never the
   first thing a member sees.

3. **Revocation is on the page.** Each key has a revoke control, approved by a key that signs here,
   through the existing route (`/authority/keys/:id/revoke`). The sole standing key may still retire
   itself (ADR 662 decision 6, the lost-device path), and the page says that is what it is about to
   do.

4. **The phone approves a new passkey.** A phone key is a standing device key and already signs
   approval descriptors through the app channel. When no passkey signs on this origin but a phone
   key stands, "Add a passkey" sends the `device_key_admin` enrollment descriptor to the phone, waits
   for the proof, and runs the registration here. This is the ordinary path after an origin move for
   anyone with a paired phone, and it needs no policy change: the signer is a standing key of the
   same human, over the server-built descriptor, on a configured origin.

5. **Nothing here changes who may authorize what.** The guard, the descriptor, the origin list and
   the countersign rule of ADR 662 stand. A member with no passkey that signs anywhere and no phone
   key is still the zero-key case, and still needs a different human admin's countersign. Whether a
   hub operator on the hub's own loopback may mint a one-time recovery code for that member instead
   is a policy question that reverses part of nick's 2026-10-19 call, and it is not decided here.
   Follows-up: lane `01M6N3YGD4GNA1PGK90TZV5V5W` holds the proposal for nick to accept or decline.
   _(Amended 2026-11-05: nick accepted the proposal that day. See the amendment below.)_

### Increments

| Increment                                              | Lane                         |
| ------------------------------------------------------ | ---------------------------- |
| A — origin and rp_id recorded, shown, no silent QR     | `01M6N3XZDCCQT2RG1H76HHDJC4` |
| B — revoke from /live settings                         | `01M6N3Y40H80TVE8N1AK6655H3` |
| C — the phone approves a new passkey                   | `01M6N3YA0JSBAR8GV6NS015PHA` |
| D — operator-minted recovery code (proposed, nick decides) | `01M6N3YGD4GNA1PGK90TZV5V5W` |

## Consequences

- A migration (`device_keys.origin`, `device_keys.rp_id`), one more field on the keys list, and
  copy on one settings panel. Old rows stay valid and are labelled as unrecorded, never guessed.
- An origin move becomes: enrol on the new origin with the phone, revoke the old keys from the page.
  No terminal, no tunnel, no second admin, for anyone with a paired phone.
- A member with passkeys only, on a team with one admin, is still locked out by an origin move until
  increment D is decided. The page now says so plainly instead of offering a QR code.
- The hub-relocation runbook keeps the 2026-11-04 procedure as history; a future switch should not
  need it.

**2026-11-05 — increment D accepted and built (lane `01M6N3YGD4GNA1PGK90TZV5V5W`).** nick accepted
the proposal in chat the day the ADR landed. The exception to ADR 662's 2026-10-19 fail-closed rule
is one act with these bounds. `musterd authority recover <member>` is taken only on a hub, only
from the hub machine's own loopback, and only with the daemon's recovery secret — a 0600 file the
daemon writes beside its store on the first ask, readable by its own OS user and by nobody else,
because on a hub that also runs agent seats (the box does) loopback alone would let a seat re-key a
human. What the caller says about themself is recorded as a claim, never as the proof. It is refused
while any key of the member's is known to sign somewhere the hub serves (a phone key, a platform
key, or a passkey whose recorded relying party is a configured passkey hostname; a passkey from
before origins were recorded does not count, since it may well be dead — the operator asks the
member first). It is refused while another human admin holds such a key: then ADR 662's countersign
applies unchanged, and the code is only for a team with nobody left who can vouch. One code is live
per member, for five minutes, used once; the mint is audited (`device_key.recovery_code`) and
announced to the whole team by the board seat, so a recovery nobody asked for is seen the minute it
is minted. The code is an enrollment challenge: the registration that spends it is accepted only
from the member it was minted for, signed in as themself (two factors: the code and their
credential), needs no standing-key approval and no admin countersign, and re-checks at that moment
that no usable key and no countersigner stands. The member redeems it on /live under Your passkeys
("I have a recovery code"). The trade, stated to nick: the hub machine's own operator can re-key a
human who has no other way back — no new reach, since they can already read the store, but a new
act, now on the record. Falsifier: a recovery code minted or spent while a usable key or a
countersigning admin stands, minted without the secret, or spent by anyone but the member.

## Observability & Evaluation

**Traces.** The `device_key.enroll` audit row carries `origin` and `rp_id` from increment A on;
`device_key.revoke` from /live is the same audit row the CLI writes today, with `surface: web`.

**Eval.** Falsifier for decisions 1–2: a passkey listed as usable on a page whose hostname differs
from the key's recorded `rp_id`, or a ceremony started on a page where no listed key can approve
it. Falsifier for decision 4: a member with a standing phone key and no matching passkey who is
sent to a terminal.

**Experiment.** n/a — a product fix to a measured failure, not a hypothesis under test.
