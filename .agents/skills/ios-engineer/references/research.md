# Research: the report this skill was written from

Step 2 of the building-a-role-skill method, merged 2026-10-21 by wallow from web research
and this repository. Every claim carries its source; licences are checked in
`PROVENANCE.md`. Written for the charter in the core file: an Expo-first iOS engineer
with a Swift native bridge, harness-agnostic.

## 1. The team's own ground (verified in this repo)

- The app is not native Swift. ADR 520 chose Expo SDK on React Native's New Architecture
  over Swift/SwiftUI, Flutter and Capacitor, because the repo is TypeScript end to end and
  the protocol is zod: a Swift app would re-declare protocol types and drift, and Android
  would be a second app. ADR 676 keeps Expo/EAS/TestFlight and replaces the calendar
  screens with the sealed ask client; its Secure Enclave, CryptoKit HPKE and App Attest
  needs go through one Expo native module as a config plugin — ADR 520's falsifier
  (a required capability needing an eject) checked, not tripped.
- Stack as built: Expo SDK 58, React Native 0.88.0, React 19.3.0, Expo Router,
  `expo-secure-store`; no local Xcode; EAS cloud builds; fastlane upload script. The calendar's
  `expo-sqlite` store and its `@musterd/protocol/calendar` subpath left on 2026-10-22 — the ask
  client's own traffic is sealed through the relay and will read `@musterd/protocol` through the
  `/app-channel` and `/approval` subpaths.
- Consequence for the craft split: the everyday craft is Expo/React Native; Swift is a
  small, security-critical bridge. A role skill written Swift-first would misfit the job.

## 2. Expo / React Native craft (verified at source)

- Expo ships first-party agent skills (`expo/skills`, MIT — see `PROVENANCE.md`):
  project structure, building native UI, the `expo-module` skill (native modules and
  views with Swift/Kotlin/TypeScript, config plugins, autolinking), data fetching,
  deployment, `eas-workflows`, `eas-app-stores` (TestFlight, profiles, versioning) and
  upgrading. These are the vendor's own procedures and stay the source for Expo mechanics;
  this skill teaches judgment and this team's constraints on top of them.
- The Expo MCP server gives any harness live Expo docs, `npx expo install` compatibility,
  EAS build/workflow triggering and logs, TestFlight crash data, and — with the local
  `expo-mcp` package and a dev server — simulator screenshots and taps by `testID`
  (Expo docs, https://docs.expo.dev/mcp/ , read 2026-10-21).
- React Native performance practice is packaged as agent skills by Vercel
  (`vercel-react-native-skills`: list performance, animations, navigation, native
  modules — cited, licence unstated, see `PROVENANCE.md`) and by Callstack
  (`react-native-best-practices`, profiling/startup/rendering). Adopted as practice
  pointers in `references/expo-app.md`, not as text.

## 3. Native Swift craft (verified at source)

- Two maintained SwiftUI agent skills exist, both MIT: Paul Hudson's `swiftui-pro`
  (twostraws/SwiftUI-Agent-Skill — deprecated APIs, state, performance, accessibility,
  data flow) and AvdLee's SwiftUI Agent Skill (concurrency, performance, view structure).
  Our bridge writes Swift with no SwiftUI surface, so what transfers is the Swift
  discipline: modern concurrency (async/await, actors, no force-unwrap), availability
  checks, and accessibility of any native view the module renders.
- `swift-ios-skills` (dpearson2699) is the broadest iOS skill set (iOS 26+, Swift 6.3,
  CryptoKit/Secure Enclave guidance included) but its licence is unstated
  (NOASSERTION): read and cite only, per ADR 579 — nothing adapted.
- Apple platform facts the skill relies on: HPKE is CryptoKit (iOS 17+ for HPKE);
  Secure Enclave keys are non-exportable and biometry-gated access control invalidates
  on biometric-set change; App Attest keys live in the Secure Enclave and attest app
  authenticity, not the user; notification service extensions run locked, time-boxed,
  and cannot prompt for biometry. Each is stated in Apple's documentation and in the
  team's ADR 676, which is the controlling source here.

## 4. Tool access: MCP servers and automation (verified at source)

- **Xcode 26.3** ships agentic coding: Claude/Codex built in, plus Apple's own MCP tools
  (build, test, previews, project exploration, documentation/WWDC search) exposed to any
  MCP client — the first-party path where Xcode exists. Our team bans local Xcode builds
  on the shared laptop, so this is opportunistic, not the default loop.
- **XcodeBuildMCP** (Sentry-owned, MIT) is the headless equivalent: build/run/test on
  simulator and device via `xcodebuild`, screenshots, logs, LLDB, UI interaction — no
  Xcode window needed. The default native verification tool where a Mac may build.
- **Apple documentation access**: Xcode's built-in documentation search, or a docs MCP
  such as sosumi (Apple docs/HIG/WWDC as markdown) or apple-docs-mcp. Needed because
  platform APIs move yearly and model memory of them is stale by construction.
- **UI automation**: Maestro (Apache-2.0, Expo's supported E2E path, built-in MCP) for
  repeatable flows; `mobile-mcp` / `ios-simulator-mcp` class servers for ad-hoc
  simulator driving and screenshots. Detox remains a valid gray-box RN option but
  Maestro is the Expo-endorsed default.
- **Release**: App Store Connect MCP servers and the `asc` CLI exist and are agent-shaped,
  but they hold store-write power. This skill's charter keeps them with the human account
  holder (core rule 8); the agent prepares, the human submits.

## 5. What was not adopted, and why

- A native-Swift-first role (SwiftUI app, Xcode project): contradicts ADR 520, strands
  the protocol in a second declaration, and has no holder on this team.
- `swift-ios-skills` as adapted text: unstated licence (reference-only under ADR 579).
- App Store Connect automation as default equipment: real store-write credentials in an
  agent workspace, against hard rule 5's spirit; preparation covers the agent's half.
- Local Xcode builds as the verification loop: banned on this team's shared laptop by
  nick's standing instruction; EAS plus simulator/device checks replace it.

## 6. Open questions only a human can answer

- Who holds this role once the skill passes its eval — a new seat, and on which harness
  (the role itself is harness-agnostic by decision, 2026-10-21)?
- Which physical device is the standing verification device for Enclave/Face ID/App
  Attest checks, and who runs the checks that need nick's face?
