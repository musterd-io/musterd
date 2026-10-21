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
    _(Amended 2026-10-20: `@hpke/dhkem-p256` does not exist; `@hpke/core` carries DHKEM(P-256)
    itself, so the daemon takes one direct dependency, with `@hpke/common` under it. See
    Consequences.)_

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
- 2026-10-20, lane 01M5BER5GX: nick approved the two packages named in decision 10 in chat. On
  install, `@hpke/dhkem-p256` turned out not to be a published package: `@hpke/core` 1.9.0 exports
  `DhkemP256HkdfSha256`, `HkdfSha256` and `Aes128Gcm` directly. The daemon depends on `@hpke/core`
  alone, which pulls in `@hpke/common` (same author, same repository). That is a smaller surface
  than the approval covered.
- 2026-10-20, lane 01M5BER5GX (increment 2, PR #3006): the pairing's wire shapes are
  `AppPairingQrSchema` and `AppPairRequestSchema` in `packages/protocol/src/appChannel.ts`. Keys
  travel raw (Ed25519 32 bytes, P-256 uncompressed 65), and the App Attest challenge is
  sha256(code ‖ signing key ‖ receive key). The pairing reuses ADR 618's single-use pairing nonce as
  decision 5's one-time code, and the phone key is enrolled through ADR 662's `enrollKeyGuarded`
  under a standing key's `device_key_admin` signature. `POST /authority/keys` now refuses kind
  `phone`, so that kind always means App Attest vouched for the key. Schema v117 keeps the phone's
  public keys on the pairing and the binding.
- 2026-10-20, lane 01M5BER5GX (increment 3a): deliveries and answers run for **advisory** asks,
  matching Slack. The wire adds `AppCallbackSchema` (the phone's `pair` / `answer` / `redeliver`),
  `AppDeliverySchema`, `AppAnswerSchema` with `appAnswerSigningBytes`, and one relay daemon frame,
  `app_deliver`. The delivery nonce is derived from the token, sha256-based, so the daemon stores
  nothing for it. A signed app answer still redeems as A1 under ADR 623 §6: the phone signature is
  checked before redemption and recorded as `signed_by`, but it does not yet widen what the answer
  authorizes. Privileged asks, listed acts with the descriptor screen (decision 6), answers from a
  notification (decision 7) and the fatigue ceiling (decision 8) are increment 3b. 3b is where
  ADR 623's "A2 does not exist yet" ends, and that change gets its own review.
- 2026-10-20, lane 01M5BEQWY8 (7b, the relay's push): the relay holds no device table. The phone
  gives its APNs device token and environment inside its sealed pairing request (`push_token`,
  `push_environment` on `AppPairRequestSchema`); the daemon keeps them on the binding and names
  them on every `app_deliver` (`push`). A binding paired without a token is not pushed and the
  daemon audits why. The relay signs an ES256 provider token with the operator's `.p8` key
  (`APNS_KEY_P8` secret; key id, Apple team id and bundle id as Worker vars) and pushes
  `mutable-content`, `time-sensitive`, the ask ref as collapse id, with a fixed placeholder alert.
  "Up to 3 KB" is measured on the encoded sealed fields (`sealedPushBytes`), so the push stays
  under APNs' 4 KB. A larger body is fetched by ref: the phone calls
  `GET /app/<slug>/body/<binding>/<ref>`, the relay asks the daemon over the socket
  (`app_fetch` → `app_body`) and returns what it answers, storing nothing; the daemon re-issues
  that one ask under a fresh token, as a re-delivery does, since it keeps no sealed body and the
  token exists only inside a seal. The phone's callbacks arrive at `POST /app/<slug>/callback`,
  shape-checked by the relay and forwarded. App deliveries keep no relay pending row: each carries
  a fresh token, so each is a new delivery. Both phone routes are unauthenticated at the relay —
  the seal is the trust — so anyone who learns a binding id can make the daemon re-issue a token
  for a live ask; the phone's answer to the old token then fails as consumed and it re-delivers.
  That is the drop-or-delay class this ADR already grants a malicious relay, widened to whoever
  holds a binding id. Rotating the push token without re-pairing is not built: the token is
  fixed at pairing, and an APNs `Unregistered` comes back to the daemon as the delivery's reason.
- The launch gate in ADR 662 can close for nick once the phone key is enrolled through this pairing.
- A lost or wiped phone is ADR 662's recovery path. A Face ID change ends the signing key the
  same way and needs the same re-key.
- What a malicious relay can still do: drop or delay. It cannot read an ask, forge one, change one,
  replay one past its nonce, or turn an advisory answer into a listed-act answer.
- 2026-10-21, lane 01M5BER5GX (increment 3b, [ADR 694](694-phone-a2-lane-verdicts.md)): listed-act
  asks reach the phone for one kind, a human's verdict on a lane review (`human_accept`), built
  against ADR 662 as it stood that day. The delivery carries an A2 token and one server-built
  descriptor per decision, plus the payload each digest commits to. The app recomputes the digest and
  renders the header with `approvalWording`, imported through the node-free
  `@musterd/protocol/approval` subpath, so decision 6's "own fixed wording" is protocol's code, not a
  copy. The answer's device signature is checked before anything is written, then the verdict is
  performed as the human's own act through the route's gate. A refusal leaves the ask open. Other
  privileged asks stay off the phone until their acts are gated (lane 01M5FZ5R2V). The fatigue
  ceiling (decision 8) is the lane's next increment.
- 2026-10-21, lane 01M5BER5GX (the fatigue ceiling, decision 8): built from the token table, with no
  new store. "Open" means a live A2 token on the human's binding whose lane still awaits acceptance;
  a token whose lane was decided on /live is spent when the queue next moves. "First delivered" is
  an ask's earliest token, so a re-delivery is not counted twice. The queue moves on a new verdict
  ask, after a verdict answer, and when the app opens. With nothing else happening, a held ask waits
  for the app to open after the hour; the summary says when (`until`). A verdict ask from a human
  seat is not metered by the hourly rule. A verdict ask's token now lives for its review window (ADR
  506), not the bare tier's 15 minutes, or a queued verdict would die before its turn. The /live flag
  for "I did not expect this" follows as its own change.
  Follows-up: 01M5BER5GX4WENE2CEST6CA8NB

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

_(2026-10-20, 7b.)_ The relay's push is checked against a fake APNs in
`workers/away-relay/src/apns.test.ts` and `index.test.ts`; the provider token verifies under the
key's public half. What the tests cannot show is that a Worker's `fetch` reaches APNs, which
accepts HTTP/2 only. The first push from the deployed relay to nick's phone settles it: an
`away_app_delivered` log line with an `apns-id` confirms it, and a protocol error from Apple
falsifies it.

**Experiment.** Pre-registered on nick's team, 30 days from the first signed answer: of the asks
answered while nick had no live laptop presence, the share answered from the app. The design holds if
that share is at least 50%. Below 20%, the app has not earned its place again, and this ADR is
revisited before App Store work begins.
