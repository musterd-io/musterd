# 780 — Over-the-air JavaScript updates for the phone app, signed with our own key

- Status: proposed
- Date: 2026-10-31
- Lane: `01M6AMENY6J25KE7YGD5Z685X3`
- Deciders: nick (asked for over-the-air updates, 2026-10-31), cider
- Relates to: [ADR 520](520-mobile-toolchain-expo.md) (Expo, with EAS Update named for
  over-the-air JavaScript), [ADR 676](676-mobile-app-sealed-ask-client.md) (the phone signs what it
  shows), [ADR 774](774-verified-answer-enters-the-session.md) (the question key), hard rule 6

## Context

Every phone change reaches nick through a TestFlight build: the `ios-testflight` workflow runs
`eas build --local` on a GitHub runner, uploads, and Apple processes it — about half an hour before
he can test, for a change that is often a line of copy or a screen layout. ADR 520 chose EAS Update
for over-the-air JavaScript but nothing wired it in: the app has no `expo-updates`, no channel and
no runtime version. MoveTrail, nick's other Expo app, ships this way already.

## Problem

1. **A JavaScript update is code the phone runs with its keys.** The JavaScript renders the ADR 662
   descriptor the phone signs (ADR 676 §6), builds every answer, and calls the Face ID and question
   keys. An update channel anyone with the EAS account can publish to is a way to put words in
   front of nick that differ from what his signature commits to. EAS's own account security is not
   enough on its own: the trust should be a key that lives where our other release secrets do.
2. **A JavaScript update must never land on a binary it does not match.** Most recent phone work is
   Swift (the notification extension, keys, sealing, the lock-screen answer path). A bundle that
   calls a native function the installed binary lacks fails at runtime.
3. **The new dependency.** `expo-updates` is a runtime dependency of the app (hard rule 6). ADR 520
   named it; this ADR records it and how it is used.

## Decision

1. **`expo-updates` in `packages/mobile`, on EAS Update, channel `production`.** The app checks on
   launch, downloads in the background, and applies the update on the next launch. A launch never
   waits on the network (`fallbackToCacheTimeout: 0`), so a dead relay or no signal changes
   nothing.
2. **Every update is code-signed, and the phone refuses an unsigned one.** The app carries the
   public certificate (`packages/mobile/certs/certificate.pem`, in the repo) and
   `codeSigningMetadata` in `app.json`; expo-updates then rejects any update whose signature does
   not verify. The private key never enters the repo or EAS. nick generates it on his own machine
   and stores it as a secret of a GitHub environment, `production-ota`, that needs his approval on
   every run; only the publish workflow reads it, through a pinned `eas-cli`. Changing the key needs
   a TestFlight build, since the certificate is in the binary.
3. **The runtime version is the native fingerprint** (`runtimeVersion: {policy: "fingerprint"}`).
   Any change to native code, a config plugin or a native dependency changes it, so an update is
   only ever offered to binaries built from the same native tree. An update published after a
   Swift change reaches no phone until a TestFlight build with that change is installed.
4. **One way to publish:** an `ios-update` workflow, dispatched by hand from the branch it
   publishes (no ref input, so the approval shows what ships), that runs
   `eas update --channel production` with the signing key from the secret. No seat publishes from
   a laptop. A publish is a deploy: it goes to nick as an ask first, as every deploy does.

## Consequences

- JavaScript-only phone changes reach nick in minutes, not half an hour, and spend none of the two
  remaining EAS cloud builds. Swift changes still go through TestFlight.
- The first build with `expo-updates` (build 40 or later) is the first that can receive updates.
  Builds before it never will.
- A lost or leaked signing key means a new key, a new certificate and a TestFlight build; until
  then a leaked key can sign updates, so it is rotated the same way as the App Store Connect key.
- EAS Update has its own free allowance (monthly active users and bandwidth), separate from the
  build quota; one tester is far inside it.
- Rolling back is publishing the previous commit, or `eas update:republish`; a bad update that
  crashes on launch is rolled back by expo-updates itself, to the last update that launched.

## Observability & Evaluation

n/a — not agent-facing: this changes how the phone app's JavaScript reaches the phone, not what an
agent sees or does. Each publish is a workflow run with its commit and runtime version in the log.
