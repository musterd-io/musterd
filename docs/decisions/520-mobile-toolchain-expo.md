# 520 — Mobile toolchain: Expo on React Native's New Architecture

- Status: proposed
- Date: 2026-10-05
- Lane: `01M472885Y78QX2PQJRPAXPC95` (goal `mobile-app`, increment 1)
- Deciders: nick (chose Expo on the New Architecture, 2026-10-05), dolly
- Relates to: [ADR 519](519-calendar-entries-as-team-data.md) (the data the app shows), hard rule
  6 (no new runtime dependency without an ADR), [ADR 002](002-dependencies.md) (the
  dependency stance this ADR is the exception to), [ADR 486](486-pg-driver-dependency.md) (the last
  dependency ADR, and this one's shape)

## Context

A native iOS app for the musterd Calendar (ADR 519), Android later, built by an agent seat. The
repo is TypeScript end to end: the protocol is zod schemas, the server and CLI import them, and the
web console is React. Every surface so far talks to the daemon over the wire and imports
`@musterd/protocol` only. The mobile app should be one more such surface, not a second codebase
that re-states the protocol by hand.

## Problem

Which toolchain, and what does it cost the monorepo and its CI? Four were weighed:

- **Swift and SwiftUI.** The most native result, Apple's own on-device Foundation Models, App
  Intents and widgets with no bridge. The protocol types would be re-declared in Swift and drift
  from the zod source; Android would be a second app; no seat on this team writes Swift daily.
- **Flutter.** One codebase for both platforms, but Dart: the protocol is re-declared again, and
  nothing in the repo is shared.
- **Capacitor.** The web console in a WebView. Shares the most code and feels the least native;
  the calendar's whole point on a phone is feel.
- **Expo on React Native.** TypeScript, imports `@musterd/protocol` directly, React like the web
  console, one codebase for iOS and Android, and native modules (Keychain, SQLite, widgets, Live
  Activities, on-device models) through Expo's module system and config plugins. The New
  Architecture (JSI, Fabric, TurboModules) is the default in current SDKs and is what makes native
  tabs and Liquid Glass components possible without ejecting.

## Decision

1. **Expo SDK on React Native's New Architecture**, the current SDK at the time increment 4 starts,
   pinned in the lockfile; Expo Router for navigation; EAS Build, Submit and Update for the native
   build, store submission and over-the-air JavaScript updates.
2. **A new workspace package, `packages/mobile` (`@musterd/mobile`, private).** It depends on
   `@musterd/protocol` and nothing else from the repo (the CLI/MCP rule: over the wire, never
   `@musterd/server`). Its `node_modules` are its own; the root `pnpm -r build` and `pnpm test` run
   its typecheck and unit tests only, never a native build. Native builds happen on EAS, triggered
   by a seat with the EAS token, not in `gates`.
3. **Runtime dependencies this ADR authorizes, all inside `packages/mobile`:** `expo`,
   `react-native`, `react`, `expo-router`, `expo-sqlite` (the local-first cache), `expo-secure-store`
   (the credential in the Keychain), `zod` (already a protocol dependency). Anything beyond these,
   including a native module for widgets, Live Activities or on-device models, is a one-line
   Consequences note here naming the module and why, not a new ADR, unless it changes what the app
   sends the daemon.
4. **Local-first.** The app keeps the calendar in SQLite on the device and reconciles with the
   daemon's `?since` delta on foreground and after a write, so it works on a plane and when the
   laptop is asleep. Writes queue and replay; the daemon's `updated_at` wins on conflict, and the
   app says when it dropped a local edit.
5. **The server URL is a setting**, with the laptop's Tailscale MagicDNS address as the first value
   (ADR 519 decision 4). No URL is compiled in.

## Consequences

- `pnpm-workspace.yaml` already includes `packages/*`; the mobile package joins the workspace with
  its own `tsconfig` extending the root. Its install adds Expo's dependency tree to
  `pnpm install --frozen-lockfile` in CI, which costs install time on every `gates` run; if that
  cost is visible in the CI cost readout (ADR 515), the package gets its own install step gated on
  `packages/mobile/**` changes.
- `docs/architecture/09-mobile.md` is the new surface doc, with the drift-checked file tree.
- The Apple Developer Program membership and App Store Connect are nick's to buy and sign up for;
  EAS Build needs them for a TestFlight build. Until then increment 4 runs as an Expo development
  build on nick's phone, which needs only a free Apple ID.
- Android is one more EAS build target when wanted; nothing in this ADR has to change.
- **2026-10-05, increment 4 (lane `01M472A1T4`) — what building it settled.** Within §1–§5, not
  against them: (a) the SDK at the start was **Expo SDK 57** (React Native 0.86, React 19.2.3), on
  pnpm's default isolated installs, which SDK 54+ supports — no `nodeLinker: hoisted`. (b) **Modules
  beyond §3's list, each because Expo Router requires it as a non-optional peer:** `expo-constants`,
  `expo-linking`, `@expo/log-box`, `@expo/metro-runtime`, `react-native-screens`,
  `react-native-safe-area-context`. None changes what the app sends the daemon. `zod` is not a direct
  dependency after all: the app reaches it only through `@musterd/protocol`. (c) The phone imports the
  protocol through two new subpath exports, `@musterd/protocol/calendar` and
  `@musterd/protocol/errors`, because the barrel pulls Node built-ins; this adds no schema. (d) The
  surface doc is `docs/architecture/09-mobile.md`, not `08-mobile.md`: 08 was already the web doc.
  (e) `app.json` carries one App Transport Security exception, plain `http` to `*.ts.net` plus local
  networking, because Tailscale is the transport's encryption (ADR 519 §4).
- **2026-10-05, increment 5 (lane `01M46YWG8YHE`): no local Xcode.** nick asked that Xcode not run
  on the laptop that hosts the seats, because it slows that machine down. The phone therefore gets
  the app through TestFlight from the start, built by EAS Build in the cloud and uploaded by EAS
  Submit; the development-build step above is skipped. Expo Go covers JavaScript-only iteration. The
  Expo project is `@nas4146/musterd`; `eas.json` pins Node and pnpm to the repo's.
- _(2026-10-19, lane `01M46YWFM5`: [ADR 676](676-mobile-app-sealed-ask-client.md) keeps Expo, EAS and TestFlight, and replaces the calendar screens with the sealed ask client. Its Secure Enclave, CryptoKit HPKE and App Attest needs go through one Expo native module as a config plugin; that is this ADR's falsifier checked, not tripped.)_

## Observability & Evaluation

n/a — a toolchain choice, not agent-facing behaviour.

- **Traces:** none new; the app is an HTTP client of routes the daemon already traces.
- **Eval:** n/a for the toolchain itself; ADR 519's eval covers the app.
- **Experiment:** none.
- **Falsifier:** increment 4 cannot reach feature parity with the artifact's views on a development
  build within two working sessions, or a required native capability (Keychain, SQLite) needs an
  eject from Expo's managed workflow; then Swift is reconsidered, with the protocol-drift cost
  priced in.
