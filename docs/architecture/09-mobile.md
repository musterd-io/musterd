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
calendar wire client are gone. What remains is the asks shell — one screen — and the app half's next
increments (pairing, the notification extension, the list, the descriptor screen) build on it.

It is a surface like the CLI and the MCP adapter: it talks over the wire and never imports
`@musterd/server`. Frames go through the node-free `@musterd/protocol/app-channel` and
`@musterd/protocol/approval` subpaths, never the barrel, which pulls Node built-ins a phone does
not have. The delivery composition and the notification answer import those subpaths; every frame
is parsed through a protocol schema at the boundary (hard rule 4).

## How it talks

**The asks screen still does not fetch.** The calendar's HTTP client and its `mscr_` credential went
out with the calendar, and the app holds no team credential — its authority is the paired device key,
not a bearer token (ADR 676 §3's trust table). The notification extension and the advisory answer
action are the first traffic: they read a pairing pin from the keychain and, only when that pin is
there, fetch a sealed body and POST an answer to the relay. Nothing writes the pin until pairing.
`app.json`'s App Transport Security exception for `ts.net` is a leftover of the calendar's direct
link; it stays for the moment and dropping it is its own small change.

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
  a one-time code and both daemon public keys. The app pins those keys, generates its own, and sends
  an App Attest–vouched pair request sealed to the daemon through the relay. The phone never holds
  the daemon's HTTP credential.
- **Reconcile.** On open the app asks the daemon, through the relay, to re-deliver what is pending
  (ADR 659): the daemon is the source of truth and the relay stores no sealed body.

## Screens

| Route | What it is |
| --- | --- |
| `/` | The asks list. It opens on its empty state ("No asks yet"). An advisory notification action is answered from here, and the screen says so only when the answer did not leave. The list, pairing and the descriptor screen are the next increments. |

## Running it on a phone (TestFlight)

The app reaches the phone through **TestFlight**, built in Expo's cloud (EAS Build) and uploaded by EAS
Submit, so no Xcode runs on the laptop that hosts the seats (nick, 2026-10-05: local Xcode builds bog
the shared laptop down). It needs the Apple Developer Program membership. `eas.json` holds one
`production` profile: Node and pnpm pinned to the repo's, the build number kept by EAS
(`appVersionSource: remote`, `autoIncrement`), and an `eas-build-post-install` hook that builds
`@musterd/protocol` so Metro can read its `dist`. The Expo project is `@nas4146/musterd`.

```bash
cd packages/mobile
npx eas-cli@latest build --platform ios --profile production --auto-submit
```

The first run asks for the Apple ID, with 2FA, and creates the signing certificate, the provisioning
profile and the App Store Connect app. A human has to run it, because those credentials are the
Apple account holder's. Every later run is non-interactive. A build appears in TestFlight after Apple
processes it (10–15 minutes); add yourself as an internal tester once in App Store Connect, and each
later build arrives on the phone by itself.

**Skipping EAS Submit's queue.** On Expo's free plan, `--auto-submit` waits in a shared queue. Build
3 sat there more than 40 minutes on 2026-10-06. The faster path is to build without
`--auto-submit` and upload the finished `.ipa` with fastlane:

```bash
npx eas-cli@latest build --platform ios --profile production --non-interactive
packages/mobile/scripts/upload-testflight.sh        # latest finished build; or pass a build id
```

The script needs an App Store Connect API key config at `~/.appstoreconnect/fastlane-musterd.json`
(`key_id`, `issuer_id`, and `key`, the `.p8` contents). fastlane refuses a `key_filepath` in that
file. It stays on the account holder's machine, so the upload is a command the human runs, not a
seat.

Then on the phone: Tailscale on, open musterd. Pairing from the laptop lands with the app's pairing
screen; until then the app opens on the asks shell.

For JavaScript-only iteration without a store build, `npx expo start` and the Expo Go app run the same
code against the same daemon. Expo Go on iOS supports only the current SDK.

## Gates

The root `pnpm test` runs the ask client's tests beside their source under `src/native/`:
`bytes.test.ts` (codec parity with the daemon's `Buffer`), `delivery.test.ts` (the composition
against route/signing literals and a real Ed25519 signature), and the notification tests
(`nonceStore`, `notice`, `push`, `pairingPin`, `answer`, `swift-drift`). `swift-drift.test.ts`
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

No new package. The device token is `UserNotifications` in the existing module. The seen-nonce
store, the token and the pairing pin are keychain items on `dev.musterd.keys`
(`AfterFirstUnlockThisDeviceOnly`), shared because both targets list the same access group
first. Read-modify-write of the nonce item is not atomic across processes; the extension is the
writer when a delivery is displayed. A store that cannot be read fails closed.

`aps-environment` is `production`. A debug install will not get a token. Locked open, a real
push, the replay drop and the Face ID action are not run here — they need a device, and an EAS
build is what produces one. The Swift in this increment is on the security review path before
it ships.

## File tree `packages/mobile/src/`

```
src/
  native/
    answer.ts              // advisory answer from a notification action: sign, seal, POST
    bytes.ts               // UTF-8 and base64url for a runtime with no Buffer and no TextEncoder
    delivery.ts            // the delivery composition — route AAD, inner {p,s}, the daemon's Ed25519 check
    nonceStore.ts          // seen-nonce verdicts; the extension's Swift copy follows this
    notice.ts              // lock-screen copy and which asks get actions
    notificationAnswers.ts // take a pending action once the app is open
    pairingPin.ts          // the keychain pin pairing writes and the extension reads
    phoneKeys.ts           // the typed TS contract of the native module modules/musterd-keys
    push.ts                // the musterd block on an APNs payload, and a fetched body
  ui/
    theme.ts               // brand.md palette (mustard accent on zinc, light and dark)
```

The screens are `.tsx` and outside the drift check; kept honest by hand:

```
src/app/_layout.tsx   // the Stack, themed from the palette
src/app/index.tsx     // the asks list — its empty state until pairing and the list land
```
