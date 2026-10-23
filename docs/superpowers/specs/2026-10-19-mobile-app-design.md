# The musterd app: a sealed ask client and the phone authenticator

**Date:** 2026-10-19
**Seat:** ryder
**Status:** design agreed with nick in the brainstorm on 2026-10-19 ("yes, write it"). Nothing is
built.
**Decision:** [ADR 676](../../decisions/676-mobile-app-sealed-ask-client.md).
**Lanes:** `01M5BER5GX4WENE2CEST6CA8NB` (7a, daemon and protocol), `01M5BEQWY8DSJGW69EQW8SAW74` (7b,
relay push), `01M50XQ1TGXNVXRF0481TCK4AA` (7, the app). Goal `away-channels`. The brainstorm itself
was lane `01M46YWFM5821RBT28NH8JAMSG` (goal `mobile-app`).
**Builds on:** the [away-channels spec](2026-10-15-away-channels-design.md) and its ADRs
[618](../../decisions/618-channel-answers-actor-is-not-authorizer.md),
[623](../../decisions/623-channel-answer-wire-and-decision-record.md) and
[659](../../decisions/659-away-relay-protocol-and-credentials.md);
[ADR 662](../../decisions/662-one-machine-per-hosted-seat.md) (human authority);
[ADR 519](../../decisions/519-calendar-entries-as-team-data.md) and
[ADR 520](../../decisions/520-mobile-toolchain-expo.md) (the calendar app this replaces).

## 1. What changed

The calendar app shipped on 2026-10-06 on the strength of "nick will use it daily". He barely does.
Asked what he reaches for his phone to do with musterd, he named two things: answer asks, and sign
risky acts. Both already had a home waiting for a phone:

- away channels increment 7, "the musterd app as an ask client with device-signed (A2) answers", the
  only way to answer a privileged ask off the computer;
- ADR 662's phone authenticator, one of the conditions before launch.

So the app is now those two jobs, and the calendar leaves it.

## 2. What the app does

| Job | How |
| --- | --- |
| Get an ask, any class | Push from the relay, sealed end to end, decrypted on the phone |
| Answer an advisory ask | From the notification or the app; the answer is still signed (Face ID) |
| Answer a listed act (ADR 662 decision 4) | Only in the app, on the descriptor screen; Face ID signs it |
| Be the phone authenticator | Its Secure Enclave key is an ADR 662 device key of kind `phone` |
| See what is waiting | One list of open asks addressed to you, with "N more waiting" when queued |

Answering has parity with Slack: anything Slack can answer, the app can. The difference is in what
they can see and prove. Slack reads the text and its answer is A1, advisory. The app's channel is
blind to the relay and its answer is A2, a signature.

Out of scope, by name: the calendar, a team view, `/live` on the phone, Android, the App Store.

## 3. The trust picture

```
daemon (laptop) ──sealed+signed──▶ relay (Worker) ──APNs──▶ phone (notification extension)
       ▲                                                          │
       └────────────── sealed answer, Face ID signature ◀─────────┘
```

| Party | Can see | Can do |
| --- | --- | --- |
| Daemon | everything | decides; re-checks current state on every answer (ADR 623 §6) |
| Relay | team, binding, ask ref, expiry, sizes | drop or delay; nothing else |
| Apple push | device token, ciphertext | drop or delay |
| Phone | the asks addressed to its human | sign what it showed, with Face ID |

What a compromised relay cannot do: read an ask; forge one (the phone checks the daemon's signature);
swap the text of one ask for another (the seal and signature are per ask); replay one (nonce and
expiry); turn an advisory answer into a listed-act answer (the daemon recomputes the class); or show
one thing and get a signature over another (the phone hashes what it rendered).

## 4. Keys

| Key | Where | Algorithm | Guard |
| --- | --- | --- | --- |
| Daemon identity | daemon secret store, chmod 600 | Ed25519 | never logged (hard rule 5) |
| Daemon receive | daemon secret store | HPKE DHKEM(P-256), HKDF-SHA256, AES-128-GCM | same |
| Phone signing (`phone` device key) | Secure Enclave | P-256 ECDSA | `biometryCurrentSet` + `privateKeyUsage`; Face ID on every use |
| Phone receive | Secure Enclave if CryptoKit's HPKE recipient accepts it, else Keychain | HPKE as above | `ThisDeviceOnly`; usable while locked so the extension can decrypt |
| APNs token key | relay Worker secret | ES256 | operator-set, ADR 659 §4 |

A Face ID change invalidates the signing key. That is wanted: someone who adds their face to a stolen
unlocked phone gets nothing. Re-keying is ADR 662's recovery path.

## 5. Pairing

1. On the daemon's own page (`/live` channel settings, never a relay page), nick picks "pair this
   phone". The daemon mints an ADR 662 one-time enrollment code and shows a QR code holding: the
   relay route for this team, the code, the daemon identity public key and the daemon receive public
   key.
2. The app scans it, pins both daemon keys, generates its two keys, and asks App Attest for an
   attestation whose challenge is `sha256(code ∥ phone signing pub ∥ phone receive pub)`.
3. The app sends the attestation and both public keys, sealed to the daemon, through the relay.
4. The daemon checks the attestation: the chain to Apple's App Attest root, the app id
   (`<team id>.<bundle id>`), the challenge, and that the attested key matches. Then it stages the
   phone's key.
5. An authenticator nick already has (the browser passkey or the laptop key) approves the phone's
   key as a `device_key_admin` act. The phone is never its own approval (ADR 662 decision 6).
6. The daemon writes `channel.app_paired` (binding, key ids, attestation verdict, no key material) and
   sends the phone a signed "paired" delivery. The app shows the daemon key's fingerprint so it can
   be compared with the page.

## 6. One ask, end to end

1. An agent's ask is routed to nick. The daemon decides whether the app gets it: channel settings
   (ADR 623, increment 6), presence gating, and the fatigue rules in §8.
2. The daemon builds the delivery: the ask's fields, the ADR 662 descriptor if it is a listed act, the
   ADR 623 token, expiry and nonce. It signs that with its identity key, then seals the signed bytes
   to the phone's receive key.
3. The relay pushes it with `mutable-content` and the `time-sensitive` interruption level. Up to 3 KB
   of sealed body rides in the push. Over that, the push carries the ask ref and the extension fetches
   the sealed body through the relay from the daemon.
4. The notification service extension opens the seal, checks the daemon signature, drops anything
   whose nonce it has already seen or whose expiry has passed, and replaces the placeholder text with
   the real one. On any failure it shows "an ask could not be verified" with no actions.
5. nick answers.
   - **Advisory:** from the notification. Face ID, then the app signs `(token, decision, nonce)`.
   - **Listed act:** the notification only opens the app. The descriptor screen renders the act from
     its fields with the app's own fixed wording for that act, so the agent cannot word it. The app hashes
     the canonical descriptor it rendered and signs `(digest, nonce, decision)` after Face ID.
6. The answer is sealed to the daemon and sent through the relay. The daemon opens it, checks the
   phone key signature, and redeems through ADR 623 §6: token unconsumed and unexpired, ask still
   open, digest unchanged, class recomputed from current state, binding generation current. For a
   listed act this is also ADR 662's A2 check. Only the daemon's durable receipt shows as "approved".

## 7. What the descriptor screen shows

Fixed fields, in this order, borrowed from the structured "authorization details" idea in OAuth RAR
rather than prose:

- the act, named from the closed list (for example "accept lane as human acceptance");
- who asked: seat, attested model and harness, and whether it is an agent or a human;
- the target: lane id and title, or the member, grant or policy named;
- the effect, from the app's fixed wording for that act (for example "closes the lane as done, recorded as
  your acceptance");
- requested at, and expires in.

Below a rule, labelled "the agent says", is the ask's body text. It never appears above the rule.

## 8. Fatigue, replay and loss

- **One listed act at a time.** At most one open listed-act ask per human is delivered to the app.
  Others queue on the daemon; the app shows "N more waiting".
- **A ceiling.** At most 6 listed-act asks per rolling hour from agent seats are delivered. Beyond
  that they are held, `channel.fatigue_held` is written, and one summary push says how many are held.
- **"I did not expect this."** Offered on decline. It writes `channel.answer_reported` and flags the
  asking seat on `/live`. It never locks the human out of anything.
- **Replay.** Expiry and nonce on every delivery; a seen-nonce store in the app; atomic consumption on
  the daemon.
- **A missed push is not a lost ask.** On open, the app asks the daemon (through the relay) to
  re-deliver its pending set. That is ADR 659's reconcile, with the daemon as the source of truth. The
  relay stores no sealed body.

## 9. Build

- **Daemon (7a):**
  - the two daemon keys;
  - sealing and signing for bindings of kind `app`, and opening sealed answers;
  - App Attest verification, using a minimal CBOR decoder for the one structure involved;
  - pairing on the daemon's page;
  - phone key enrollment through `device_key_admin`;
  - the fatigue rules, the four audit rows, and the falsifier cases;
  - the HPKE dependency (`@hpke/core`, `@hpke/dhkem-p256`), recorded in ADR 676 §10.
- **Relay (7b):**
  - the APNs token key and the push send;
  - the inline-or-fetch body;
  - the re-deliver frame;
  - versioned frames in `packages/protocol/src/relay.ts` and the Worker's copy.
- **App (7):**
  - remove the calendar screens;
  - one Expo native module (a config plugin, no eject) for Secure Enclave keys, CryptoKit HPKE and
    App Attest;
  - the notification service extension;
  - pairing, the asks list, the descriptor screen and answering;
  - TestFlight builds through EAS, as today.

Open questions, settled in the increment that meets them, not here:

1. ~~Whether CryptoKit's HPKE recipient takes a Secure Enclave key directly. If not, the receive key is a
   `ThisDeviceOnly` Keychain key.~~ **Settled yes** (lane `01M5K5ZJRAAK8E935BQH6CXXAX`, 2026-10-22):
   `SecureEnclave.P256.KeyAgreement.PrivateKey` conforms to `HPKEDiffieHellmanPrivateKey`, so
   `HPKE.Recipient` takes the enclave key directly — no Keychain fallback needed. The receive key is an
   enclave key-agreement key (`privateKeyUsage`, `AfterFirstUnlockThisDeviceOnly`, no biometry), and its
   CryptoKit `dataRepresentation` is persisted in the app's own Keychain item so the notification
   extension reloads the same key across processes.
2. Whether a notification action can present Face ID for a Secure Enclave signature in place. If not,
   the advisory action opens the app to a one-tap confirm screen.

## 10. How we will know

The design holds if, over the 30 days after the first signed answer, at least half of the asks nick
answered while he had no live laptop presence were answered from the app. Below one in five, the app
has not earned its place, and ADR 676 is revisited before any App Store work.

The away-channels falsifier suite gains the malicious-relay cases listed in ADR 676's Eval. The suite
must refuse all of them before the app's first TestFlight build goes to nick.
