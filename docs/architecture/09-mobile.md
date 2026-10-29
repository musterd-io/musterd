# 09 — Mobile surface (`@musterd/mobile`)

> **Living document.** Direction, not gospel: if it disagrees with the code, fix the smaller of the two
> in the same commit; a real disagreement is an ADR. The decisions behind this surface are
> [ADR 676](../decisions/676-mobile-app-sealed-ask-client.md) (the app as a sealed ask client and the
> phone authenticator) and [ADR 520](../decisions/520-mobile-toolchain-expo.md) (Expo on the New
> Architecture). The calendar it replaces is [ADR 519](../decisions/519-calendar-entries-as-team-data.md),
> which stays the daemon's data model.

## What the mobile package is

`@musterd/mobile` is musterd on a phone, with two jobs (ADR 676 §2): **answer asks** off the
computer, and **be the phone authenticator** — its Secure Enclave key signs what the app showed, with
Face ID. iOS only, TestFlight only (ADR 676 decision 11); the calendar, a team view, `/live` on the
phone, Android and the App Store are out of scope by name.

The calendar shipped first (ADR 519 and ADR 520's app half) and left this package on 2026-10-22
(lane `01M5K5ZJBZPE5SZC4HD6HHC0VJ`): screens, the local-first sync, the SQLite device store and the
calendar wire client are gone. What remains is the asks list, the ask and descriptor screen, and
the pairing screen.

It is a surface like the CLI and the MCP adapter: it talks over the wire and never imports
`@musterd/server`. Frames go through the node-free `@musterd/protocol/app-channel` and
`@musterd/protocol/approval` subpaths, never the barrel, which pulls Node built-ins a phone does
not have. The delivery composition and the notification answer import those subpaths; every frame
is parsed through a protocol schema at the boundary (hard rule 4).

## How it talks

**The app talks only to the relay.** The calendar's HTTP client and its `mscr_` credential went
out with the calendar, and the app holds no team credential — its authority is the paired device key,
not a bearer token (ADR 676 §3's trust table). The extension, the advisory answer action and the
asks list read a pairing pin from the keychain and, only when that pin names a binding, fetch sealed
bodies and POST answers to the relay. Pairing writes the pin when the relay accepts the request, and
leaves `binding` off: the channel binding id does not exist until a standing key approves the phone.
The extension writes that id back after the first delivery whose daemon signature verifies, and does
not replace a binding it already stored. The phone's device key id comes the same way, from the
signed `paired` delivery (`device_key_id` on the pin): a listed-act answer names it as its proof's
`key_id`. `app.json`'s App Transport Security exception for `ts.net`
is a leftover of the calendar's direct link; it stays for the moment and dropping it is its own
small change.

**What it is being wired to** ([spec §3–§6](../superpowers/specs/2026-10-19-mobile-app-design.md)):

- **In.** The away relay pushes a sealed delivery with `mutable-content` and the `time-sensitive`
  interruption level; the notification service extension opens the seal with this phone's HPKE
  receive key and checks the daemon's Ed25519 signature against the key pinned at pairing. A sealed
  body over 3 KB is not pushed: the push carries the ask ref and the phone fetches the body through
  the relay. Any failure shows a generic "an ask could not be verified" with no actions. The
  composition that performs those steps for app-side reads is `src/native/delivery.ts` (below);
  the extension runs its own copy of them in Swift, where it cannot run JavaScript.
- **Out.** The answer is sealed to the daemon and POSTed to the relay's callback route; the daemon
  redeems it through ADR 623 §6, re-checking current state. The relay answers `202` whatever the
  daemon decides, so a phone learns the verdict only from a later redelivery — 202 means *delivered*,
  not *accepted*.
- **Pairing.** `musterd channels pair --channel app` (ADR 690) prints a QR carrying the relay route,
  a one-time code and both daemon public keys, and the daemon identity fingerprint beside it. The
  app scans that QR ([ADR 727](../decisions/727-phone-scans-pairing-qr.md)), shows the same
  fingerprint, and only then generates its keys and sends an App Attest–vouched pair request sealed
  to the daemon through the relay. The phone never holds the daemon's HTTP credential, and it never
  approves its own key. The screen stays on "Waiting for approval" until the extension has stored
  the binding from the signed `paired` delivery. A phone with no push token pairs, and stays on
  that screen, because nothing else can deliver the binding.
- **Reconcile.** On open the app asks the daemon, through the relay, to re-deliver what is pending
  (ADR 659): the daemon is the source of truth and the relay stores no sealed body. It asks at most
  once a minute, because each request re-pushes every pending ask. A re-pushed ask that is already
  in Notification Center lands in the list with no banner and no sound; only a new one alerts.
- **A tap opens the ask.** Tapping a notification takes it out of Notification Center, and so
  off the list; the app opens that ask's screen instead. An ask with lock-screen actions says
  "Press and hold to answer". On the ask screen a relay 404 is "Already settled"; a 503, 504 or
  no network is retried once and then "Couldn't reach your team", with Try again.
- **The list.** Notification Center says which asks reached the phone, not which are still open, so
  each ref there is fetched by ref through the relay. The daemon answers only for an ask still live
  on this binding, re-issued with a fresh token (the old one is spent), so a decided or expired ask
  drops out. Because a fetch spends the previous token, the list does not refresh while the ask
  screen — which holds its own token — is in front.
- **A listed act.** The ask screen fetches the ask again for fresh descriptors (they live five
  minutes), hashes each offer's payload on the phone (`offer.ts`), shows nothing whose digest does not
  match, and words the header with `approvalWording`. Approving signs the answer bytes and the
  rebuilt descriptor under one Face ID (`signAll`; after the first signature the native side forbids
  a second prompt). Decline also comes as "I did not expect this" (`reported`, written by the daemon
  as `channel.answer_reported`).

## Screens

| Route | What it is |
| --- | --- |
| `/` | Home. One header in every state: a greeting, one headline ("2 asks need you", "All clear", "Pair this phone") and a status pill (paired with the team, waiting for approval, not paired). Below it, every open ask that reached this phone, newest first, with who asked, the app's own wording for a listed act, a Face ID chip, and "N more waiting"; or, with none, the mark and one line; or, unpaired, three pairing steps and Scan. A held summary shows as a banner while its hour lasts. Pull to refresh re-delivers. An advisory notification action is answered from here, and the screen says so only when the answer did not leave. |
| `/ask/[ref]` | One ask. A listed act is the descriptor screen (spec §7): the act in fixed wording, who asked, target, authority, requested at, expires in, and only below a rule, labelled as theirs, the asker's words and the lane title. Approve, Decline, and "Decline — I did not expect this". A sent answer says it is sent, not approved: only the daemon's receipt decides. |
| `/pair` | Scan the daemon page's QR (or paste it), compare the fingerprint, send the sealed pair request, and wait. The phone does not approve itself. |

## Running it on a phone (TestFlight)

The app reaches the phone through **TestFlight**. It needs the Apple Developer Program membership.
`eas.json` holds one `production` profile: Node and pnpm pinned to the repo's, the build number kept
by EAS (`appVersionSource: remote`, `autoIncrement`), and an `eas-build-post-install` hook that
builds `@musterd/protocol` so Metro can read its `dist`. The Expo project is `@nas4146/musterd`. The
config plugin also declares the `MusterdNotify` extension (`io.musterd.app.notify`) under
`extra.eas.build.experimental.ios.appExtensions`, which is how EAS knows to make its provisioning
profile; an undeclared extension target fails to sign.

**Build locally, upload with fastlane** (nick, 2026-10-29). EAS's cloud builds took about 20 minutes
on the free plan, most of it queue, so the build runs on the Mac that ships: `eas build --local`,
which uses the same EAS-managed signing and remote build number and is free. It needs Xcode (27.1)
and CocoaPods on that Mac, and the Expo login. fastlane then uploads the `.ipa`:

```bash
cd packages/mobile
npx eas-cli@latest build --platform ios --profile production --local --non-interactive --output /tmp/musterd.ipa
scripts/upload-testflight.sh /tmp/musterd.ipa
```

This reverses nick's 2026-10-05 ruling that no Xcode runs on the laptop that hosts the seats. The
build takes that Mac's CPU for its length. The cloud path still works when it should not:
`npx eas-cli@latest build --platform ios --profile production --non-interactive`, then
`scripts/upload-testflight.sh` with no argument (the latest finished cloud build) or an EAS build
id. Avoid `--auto-submit`: EAS Submit's free queue held build 3 for more than 40 minutes on
2026-10-06.

The first EAS build asked for the Apple ID, with 2FA, and created the signing certificate, the
provisioning profile and the App Store Connect app; every later build is non-interactive. A build
appears in TestFlight after Apple processes it (10–15 minutes); add yourself as an internal tester
once in App Store Connect, and each later build arrives on the phone by itself.

The script needs an App Store Connect API key config at `~/.appstoreconnect/fastlane-musterd.json`
(`key_id`, `issuer_id`, and `key`, the `.p8` contents). fastlane refuses a `key_filepath` in that
file, and its upload needs Xcode, not only the Command Line Tools. The key stays on the Mac that
ships.

Then on the phone: Tailscale on, open musterd. Pairing from the laptop is the app's pairing screen.

For JavaScript-only iteration without a store build, `npx expo start` and the Expo Go app run the same
code against the same daemon. Expo Go on iOS supports only the current SDK.

## Gates

The root `pnpm test` runs the ask client's tests beside their source under `src/native/`:
`bytes.test.ts` (codec parity with the daemon's `Buffer`), `sha256.test.ts` (the same, for the
fingerprint and the App Attest challenge), `delivery.test.ts` (the composition against
route/signing literals and a real Ed25519 signature), `pairingQr.test.ts` and `pair.test.ts` (the
QR, the challenge, the sealed request and the pin written with no binding), and the notification
tests (`nonceStore`, `notice`, `push`, `pairingPin`, `answer`, `swift-drift`). `swift-drift.test.ts`
reads the Swift sources and pins the lock-screen sentences. The macOS `logic-check.swift` next
to the module runs the same route, nonce and notice cases through the Swift copy; it is not a
CI job. The mobile `tsconfig` excludes `*.test.ts` from `tsc --noEmit`, exactly as every
package's does. No gate runs a native build or Metro (ADR 520 §2);
for a change here the checks worth running by hand are:

```bash
cd packages/mobile
npx expo-doctor            # 20/20
npx expo prebuild -p ios   # Continuous Native Generation still generates the project
npx expo export -p ios     # Metro still bundles it
```

## Native keys (`modules/musterd-keys`)

The phone's two keys and the three primitives over them (ADR 676 §2) are a local Expo native
module — plain Swift over CryptoKit, Security and DeviceCheck, one config plugin, no eject:

- `modules/musterd-keys/ios/PhoneKeys.swift` — the security surface: two Secure Enclave keys
  (a Face ID–guarded signing key, `biometryCurrentSet`; a receive key usable while locked,
  `AfterFirstUnlockThisDeviceOnly`), HPKE seal/open with the daemon's exact suite
  (DHKEM(P-256, HKDF-SHA256) + AES-128-GCM, `info` = `musterd-app/v1 <purpose>`), the Ed25519
  check (`verifyEd25519` — pure public-key work, no enclave and no Face ID, so the extension
  can run it while locked), and App Attest. Every call fails closed with one of five named
  codes (`unavailable`, `biometry-failed`, `key-invalidated`, `sealed-open-failed`,
  `attest-failed`) and no error carries key material or plaintext.
- `modules/musterd-keys/ios/MusterdKeysModule.swift` — the Expo DSL wrapper; the TypeScript
  contract it matches is `src/native/phoneKeys.ts`. The module holds no wire format: `purpose`
  and `aad` pass through to HPKE and `verifyEd25519` takes raw bytes, so the delivery
  composition stays in TypeScript.
- `plugins/withMusterdKeys.js` — prebuild-time it sets `NSFaceIDUsageDescription`, the App
  Attest entitlement (`production`), `aps-environment` (`production`), the time-sensitive
  entitlement, a keychain access group scoped to the bundle id as the **first** group, and
  refuses a prebuild whose `ios.deploymentTarget` is below 17 (CryptoKit HPKE is iOS 17+; the
  deployment target lives in `app.json`). It also adds the `MusterdNotify` extension target.
- `modules/musterd-keys/ios/MusterdPushSubscriber.swift` — an `ExpoAppDelegateSubscriber`
  (declared in `expo-module.config.json`). It registers the advisory category, asks for
  notification permission including Time Sensitive, stores the APNs device token, and keeps a
  notification action until JavaScript takes it. The extension cannot do any of those.
- `modules/musterd-keys/ios/extension/` — the notification service extension. `NotificationService.swift`
  is the principal class and is excluded from the app pod. The other files (route JSON, the
  seen-nonce rule, the keychain store, the lock-screen copy, the seal open) compile into both
  the app and the extension. The extension compiles `PhoneKeys.swift` with
  `NOTIFICATION_EXTENSION` set, which leaves App Attest out.

The enclave keys never leave it; CryptoKit persists each key's `dataRepresentation` in the app's
own Keychain items so the notification extension reloads the same keys across processes. A reload
failure is `key-invalidated` — the next `getPublicKeys()` re-creates the key, which the daemon
sees as a new key at the next pair (ADR 662's recovery). Swift compile and the HPKE/signature
interoperability with the daemon are proven on every change by `swiftc -typecheck` plus a local
round-trip against `@hpke/core`; the on-device build is EAS's (below).

## The delivery composition (`src/native/delivery.ts`)

What the phone does with anything sealed to it — byte-for-byte the daemon's own steps
(`notify/appSeal.ts`'s `sealToPhone` / `openAsPhone`), in TypeScript where the protocol schemas
live:

1. the canonical-JSON route becomes the HPKE AAD (base64url), so a body moved to another route
   does not open;
2. `phoneKeys.open` opens the seal with purpose `deliver`;
3. the inner `{p, s}` JSON is read — payload and the daemon's Ed25519 signature;
4. `phoneKeys.verifyEd25519` checks that signature over
   `musterd-app/v1 signed\n<route>\n<payload>` against the identity key pinned at pairing;
5. the payload is parsed through `AppDeliverySchema` (hard rule 4);
6. an expired delivery raises `DeliveryExpiredError` — dropped before display, never shown as
   unverified; the seen-nonce drop (decision 8) is the caller's, against its nonce store, which
   this module does not hold.

Every failure of steps 1–5 leaves as one `DeliveryUnverifiedError` carrying the design's single
generic text — "an ask could not be verified" — and never which check refused (that distinction
is an oracle, ADR 676 decision 3). The byte codecs it needs (`utf8Encode`, `b64urlEncode`, …)
are `src/native/bytes.ts`, because the app's runtime has neither `Buffer` nor `TextEncoder`;
their parity with the daemon's `Buffer` is held by `bytes.test.ts`, and `delivery.test.ts` pins
the route JSON and signing-message literals against a real Ed25519 signature.

## The notification extension

Lane `01M5K5ZK0K` (ADR 676 decisions 3, 7 and 8). The relay's push carries a placeholder alert
and `mutable-content`. `NotificationService` opens the seal with the receive key, checks the
daemon's Ed25519 signature, and replaces the placeholder. A failure shows exactly "an ask could
not be verified", with no actions and no sound. A seen nonce or an expiry shows "This ask is no
longer available." — the extension cannot withdraw an alert, and an empty body would deliver the
placeholder instead. The nonce is consumed only after the seal and the signature verify, and
not for an expiry or an unverified body.

An advisory ask with no approval gets Approve and Decline (`musterd.ask.advisory`). Each action
is `authenticationRequired` and `foreground`; Decline is also `destructive`. That Face ID is the
action's. The app then signs with the enclave key, which asks for Face ID again, and seals the
answer to the daemon (`purpose: answer`, plaintext the `AppAnswer` JSON, AAD the canonical
route) and POSTs it to `{relay}/app/{team}/callback`. The daemon opens that POST with
`openFromPhone` on `{team, binding, ref, expires_at}`. A listed act has no actions. The
seen-nonce store blocks a second display; it does not block the answer of the notification
already on screen.

The extension's binding check is skipped only while the stored pin has no binding. After the open
verifies, `PinBinding` writes the route's binding into that pin. A stored binding that disagrees
is still refused, and it is not overwritten. `logic-check.swift` runs that decision.

The camera is `expo-camera` (ADR 727), used on the pairing screen to read a QR. The config plugin
sets the camera usage string and does not add a microphone permission. No other package was added
for the token, the nonce store, or the pin: the device token is `UserNotifications` in the existing
module. The seen-nonce store, the token and the pairing pin are keychain items on `dev.musterd.keys`
(`AfterFirstUnlockThisDeviceOnly`), shared because both targets list the same access group
first. Read-modify-write of the nonce item is not atomic across processes; the extension is the
writer when a delivery is displayed. A store that cannot be read fails closed.

The app is light only and set in DM Sans throughout, data included (ADR 760). `expo-font`'s config
plugin embeds static DM Sans TTFs from `assets/fonts/`, instanced from the web's variable file, and
styles name them through `font` in `src/ui/theme.ts`; figures that must line up, like the pairing
fingerprint, use tabular digits. `expo-haptics` gives a press a
light tick and an answer sent or a phone paired a success buzz. Cards are Liquid Glass on iOS 26 (`expo-glass-effect`, solid
white before it) and the app's glyphs are SF Symbols (`expo-symbols`), ADR 764. The icon is `assets/icon.svg`
(the ADR 702 mark, full-bleed) rendered to `icon.png`; `wordmark.png` and `mark.png` are the
ADR 704 nameplate and the mark, rendered from `docs/design/assets/`.

`aps-environment` is `production`. A debug install will not get a token. Locked open, a real
push, the replay drop and the Face ID action are not run here — they need a device, and an EAS
build is what produces one. The Swift in this increment is on the security review path before
it ships.

## File tree `packages/mobile/src/`

```
src/
  assets.d.ts              // an imported .png is a Metro asset id for <Image source>
  native/
    answer.ts              // sign, seal, POST an answer: the notification action's, and the app's (listed acts too)
    asks.ts                // the asks list: Notification Center refs, each fetched live by ref; redeliver
    bytes.ts               // UTF-8 and base64url for a runtime with no Buffer and no TextEncoder
    delivery.ts            // the delivery composition — route AAD, inner {p,s}, the daemon's Ed25519 check
    nonceStore.ts          // seen-nonce verdicts; the extension's Swift copy follows this
    notice.ts              // lock-screen copy and which asks get actions
    notificationAnswers.ts // take a pending action once the app is open; a plain tap opens its ask
    offer.ts               // a listed act's offer as shown and signed: digest checked on the phone
    pair.ts                // after the fingerprint matches: keys, attestation, seal, POST, pin
    pairingPin.ts          // the keychain pin pairing writes and the extension reads
    pairingQr.ts           // the QR parse, the relay origin, the fingerprint, the challenge
    phoneKeys.ts           // the typed TS contract of the native module modules/musterd-keys
    push.ts                // the musterd block on an APNs payload, and a fetched body
    sha256.ts              // SHA-256, matching the daemon's createHash, with no node: import
  ui/
    haptics.ts             // a light tick under a press, a success buzz when something lands (ADR 760)
    theme.ts               // brand.md palette (mustard accent on zinc), light only; DM Sans faces (ADR 760)
```

The screens are `.tsx` and outside the drift check; kept honest by hand:

```
src/app/_layout.tsx   // the Stack, themed from the palette; the nameplate wordmark heads Asks
src/app/index.tsx     // the asks list — its empty state, and the way into pairing
src/app/pair.tsx      // scan the QR, compare the fingerprint, wait for approval
src/app/ask/[ref].tsx // one ask: the descriptor screen for a listed act, and answering
src/ui/glass.tsx      // Glass (Liquid Glass card, solid fallback) and the warm Backdrop (ADR 764)
src/ui/icon.tsx       // an SF Symbol in the text's colour, with a text fallback (ADR 764)
src/ui/motion.tsx     // Rise, Squish, Breathe, Pop, Halo — RN Animated, off under Reduce Motion
src/ui/seat.tsx       // a member's seat avatar (the mark's sand and teal) and relative time
```
