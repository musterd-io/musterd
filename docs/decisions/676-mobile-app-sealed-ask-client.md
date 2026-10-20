# 676 — The musterd app is a sealed ask client and the phone authenticator

- Status: accepted
- Date: 2026-10-19
- Lane: `01M46YWFM5821RBT28NH8JAMSG` (goal `mobile-app`)
- Deciders: nick (direction in the brainstorm, 2026-10-19), ryder
- Spec: [`2026-10-19-mobile-app-design.md`](../superpowers/specs/2026-10-19-mobile-app-design.md)
- Relates to: [ADR 519](519-calendar-entries-as-team-data.md) and [ADR 520](520-mobile-toolchain-expo.md)
  (the calendar app this replaces), [ADR 618](618-channel-answers-actor-is-not-authorizer.md) (A1 and
  A2), [ADR 623](623-channel-answer-wire-and-decision-record.md) (the ask token and redemption),
  [ADR 659](659-away-relay-protocol-and-credentials.md) (the relay),
  [ADR 662](662-one-machine-per-hosted-seat.md) (listed acts, the descriptor, the phone as an
  authenticator), hard rules 1, 5 and 6

## Context

On 2026-10-05 the general iOS app stayed deferred, with one carve-out: a calendar-only app, because
nick would use it daily. It shipped (`packages/mobile`, Expo, TestFlight, build 6 on 2026-10-06). On
2026-10-19 nick said he barely uses it. The carve-out's premise did not hold.

Two later decisions now need a phone. The away-channels spec (2026-10-15) names "the musterd app" as
the only way to answer a privileged ask off the computer (increment 7). ADR 662 makes the phone one of
three authenticators for high-authority acts and lists "the phone key in pairing" among the conditions
before launch. Asked what he would reach for his phone to do, nick named two things: answer asks, and
sign risky acts. He asked for the strongest design available.

## Problem

ADR 659's relay carries a delivery's rendered content in flight. That is acceptable for Slack, which
must read the text to show it, but it means a relay operator, or anyone who compromises it, reads
every ask. Nothing yet says how the phone proves it is the musterd app on a real device, how it knows
an ask came from its own daemon, or what stops an agent from flooding a human with approvals until
one gets tapped through.

## Decision

1. **The app's job is asks and signatures.** It answers every ask Slack can (parity), and it is the
   only off-computer surface that can answer a listed act (ADR 662 decision 4). The calendar leaves
   the app. Calendar data and routes stay on the daemon.

2. **The relay is blind for the app channel.** Each delivery to the app is sealed with HPKE
   (RFC 9180, base mode) to the phone's encryption key, and each answer is sealed to the daemon's.
   The relay and Apple's push service carry ciphertext plus routing metadata (team, binding, ask ref,
   expiry). Slack keeps ADR 659's in-flight model. A sealed payload over 3 KB is not put in the push;
   the push carries the ask ref and the phone fetches the sealed body through the relay.

3. **The daemon signs what it sends.** The daemon holds an Ed25519 identity key (a new secret,
   chmod 600 beside its other secrets, never logged). Every sealed delivery is signed inside the seal.
   The phone pins the daemon's public key at pairing and shows nothing it cannot verify. A failed
   decrypt or signature shows a generic "an ask could not be verified" and offers no buttons.

4. **The phone's keys live in the Secure Enclave.**
   - The **signing key** is the ADR 662 device key, kind `phone`: P-256, non-exportable, usable only
     with `biometryCurrentSet`. Every signature takes Face ID. Enrolling a new face invalidates it;
     re-keying goes through ADR 662 decision 6.
   - The **encryption key** decrypts in the notification service extension, which runs while the
     phone is locked, so it does not require biometry. It is `ThisDeviceOnly` and never leaves the
     device.

5. **Pairing pins both ends and attests the app.** The daemon's own page (never the relay's) shows a
   QR code carrying the team's relay route, a one-time enrollment code (ADR 662) and the daemon's
   signing and encryption public keys. The phone generates its keys and an App Attest attestation
   whose challenge binds the enrollment code and both public keys. The daemon verifies the attestation
   chain to Apple's App Attest root, the app id and the challenge before it records anything. An
   existing authenticator (a passkey or the laptop key) then approves the phone's key as a
   `device_key_admin` act. The phone never enrolls itself.

6. **The phone signs what it shows.** For a listed act, the app renders the ADR 662 descriptor from
   its fields, using its own fixed wording for each act on the closed list, computes the canonical digest
   from the bytes it rendered, and signs that digest with the nonce. It never signs a digest handed to
   it. The agent's own words appear below the descriptor, labelled as the agent's, and never in the
   approval header.

7. **What can be answered where.** An advisory ask can be answered from the notification. The answer
   is still signed, so the action asks for Face ID. A listed act cannot be answered from the
   notification: it opens the descriptor screen. Every answer redeems through ADR 623 §6's recheck
   (recomputed class, current binding generation, unconsumed token).

8. **Replay and fatigue.** Each sealed delivery carries its token's expiry and nonce. The app keeps a
   store of nonces it has seen and drops a replay before display. Per human:
   - at most **one** open listed-act ask is delivered to the app at a time; the rest queue, and the app
     shows how many are waiting;
   - at most **6** listed-act asks per rolling hour are delivered from agent seats; beyond that they are
     held and one summary is sent;
   - a decline can be marked "I did not expect this", which writes an audit row and flags the asking
     seat on `/live`. Nothing locks the human out.

9. **The relay sends the push.** The Worker holds the APNs token key (a new secret in the operator's
   Cloudflare account, ADR 659 §4's handling), so no team needs an Apple account. A delivery the push
   misses is not lost: on open, the app asks the daemon (through the relay) to re-deliver its pending
   set, which is ADR 659's reconcile with the daemon as the source of truth. The relay stores no sealed
   body.

10. **Two new runtime dependencies (hard rule 6).** On the daemon: an HPKE implementation (`@hpke/core`
    with `@hpke/dhkem-p256`, pure TypeScript on WebCrypto), because Node has no HPKE. The alternative,
    hand-rolling the RFC 9180 key schedule on `node:crypto`, was rejected as security code we would
    own. For App Attest's CBOR, a minimal decoder for the one structure involved, written in the
    daemon, rather than a general CBOR library. On the phone, CryptoKit's `HPKE` and Secure Enclave
    APIs, through one small Expo native module. ADR 520's falsifier ("a required native capability
    needs an eject") is checked by that module: a config plugin, not an eject.

11. **TestFlight, iOS only.** The app ships to nick through TestFlight. App Store review waits until an
    outside user needs the phone authenticator, since passkeys cover them meanwhile. Android is one more
    EAS target later, with its own key-storage review.

## Consequences

- The ROADMAP's "iOS deferred" line records this carve-out: an app for asks and signatures, not the
  general surface. A team view, `/live` on the phone, and the calendar stay deferred.
- ADR 519 stays as the calendar's data model. Its app half (ADR 520 increments 4 and 5) is withdrawn
  with the calendar screens.
- Increment 7 of away channels splits into three lanes: the daemon and protocol half, the relay's
  push, and the app.
  Follows-up: 01M5BER5GX4WENE2CEST6CA8NB
  Follows-up: 01M5BEQWY8DSJGW69EQW8SAW74
  Follows-up: 01M50XQ1TGXNVXRF0481TCK4AA
- The launch gate in ADR 662 can close for nick once the phone key is enrolled through this pairing.
- A lost or wiped phone is ADR 662's recovery path. A Face ID change ends the signing key the
  same way and needs the same re-key.
- What a malicious relay can still do: drop or delay. It cannot read an ask, forge one, change one,
  replay one past its nonce, or turn an advisory answer into a listed-act answer.

## Observability & Evaluation

**Traces.** New audit rows: `channel.app_paired` (binding, key ids, attestation result, no key
material), `channel.sealed_delivered` (ask ref, binding, size, inline or fetched),
`channel.fatigue_held` (human, count, reason), and `channel.answer_reported` (the "I did not expect
this" mark). Signed answers keep ADR 662's `authority.*` rows.

**Eval.** The away-channels falsifier suite gains these malicious-relay cases, each refused: a resent
sealed delivery past its nonce; a ciphertext swapped between two asks; an unsigned or wrongly signed
ask injected; a stripped seal sent as plaintext; a pairing with a forged or mismatched attestation; a
signature over a digest the phone did not render; a listed act answered from a notification action; a
seventh listed-act ask in an hour delivered rather than held.

**Experiment.** Pre-registered on nick's team, 30 days from the first signed answer: of the asks
answered while nick had no live laptop presence, the share answered from the app. The design holds if
that share is at least 50%. Below 20%, the app has not earned its place again, and this ADR is
revisited before App Store work begins.
