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
`@musterd/server`. When it starts reading frames it will take them through the node-free
`@musterd/protocol/app-channel` and `@musterd/protocol/approval` subpaths, never the barrel, which
pulls Node built-ins a phone does not have. Today no protocol subpath is imported at all, and every
frame the app does read is parsed through a protocol schema at the boundary (hard rule 4).

## How it talks

**Today: it does not.** The calendar's HTTP client and its `mscr_` credential went out with the
calendar, and the app holds no team credential at all — its authority is the paired device key, not a
bearer token (ADR 676 §3's trust table). Nothing in the app requests plain HTTP to a daemon now, so
`app.json`'s App Transport Security exception for `ts.net` is a leftover of that direct link; it stays
for the moment and dropping it is its own small change.

**What it is being wired to** ([spec §3–§6](../superpowers/specs/2026-10-19-mobile-app-design.md)):

- **In.** The away relay pushes a sealed delivery with `mutable-content` and the `time-sensitive`
  interruption level; the notification service extension opens the seal with this phone's HPKE
  receive key and checks the daemon's Ed25519 signature against the key pinned at pairing. A sealed
  body over 3 KB is not pushed: the push carries the ask ref and the phone fetches the body through
  the relay. Any failure shows a generic "an ask could not be verified" with no actions.
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
| `/` | The asks list. It opens on its empty state ("No asks yet"); the list itself, pairing and the descriptor screen arrive with the app half's next increments. |

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

The root `pnpm test` runs no mobile tests today: the calendar's Node tests (views, sync, the wire
client) left with it on 2026-10-22, and the ask client's tests arrive with its logic.
`pnpm typecheck` runs the package's `tsc --noEmit`. No gate runs a native build or Metro (ADR 520 §2);
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
  (DHKEM(P-256, HKDF-SHA256) + AES-128-GCM, `info` = `musterd-app/v1 <purpose>`), and App
  Attest. Every call fails closed with one of five named codes (`unavailable`,
  `biometry-failed`, `key-invalidated`, `sealed-open-failed`, `attest-failed`) and no error
  carries key material or plaintext.
- `modules/musterd-keys/ios/MusterdKeysModule.swift` — the Expo DSL wrapper; the TypeScript
  contract it matches is `src/native/phoneKeys.ts`. The module holds no wire format: `purpose`
  and `aad` pass through to HPKE, so the delivery composition stays in TypeScript.
- `plugins/withMusterdKeys.js` — prebuild-time it sets `NSFaceIDUsageDescription`, the App
  Attest entitlement (`production`), a keychain access group scoped to the bundle id, and
  refuses a prebuild whose `ios.deploymentTarget` is below 17 (CryptoKit HPKE is iOS 17+; the
  deployment target lives in `app.json`).

The enclave keys never leave it; CryptoKit persists each key's `dataRepresentation` in the app's
own Keychain items so the notification extension reloads the same keys across processes. A reload
failure is `key-invalidated` — the next `getPublicKeys()` re-creates the key, which the daemon
sees as a new key at the next pair (ADR 662's recovery). Swift compile and the HPKE/signature
interoperability with the daemon are proven on every change by `swiftc -typecheck` plus a local
round-trip against `@hpke/core`; the on-device build is EAS's (below).

## File tree `packages/mobile/src/`

```
src/
  native/
    phoneKeys.ts    // the typed TS contract of the native module modules/musterd-keys
  ui/
    theme.ts          // brand.md palette (mustard accent on zinc, light and dark)
```

The screens are `.tsx` and outside the drift check; kept honest by hand:

```
src/app/_layout.tsx   // the Stack, themed from the palette
src/app/index.tsx     // the asks list — its empty state until pairing and the list land
```
