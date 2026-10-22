# Provenance

Built 2026-10-21 by wallow with the `building-a-role-skill` method (ADR 586), lane
`01M5GKZRY5`, on team revive. Upstream material was surveyed and its ideas adapted and
rewritten in this team's voice; no upstream file was copied whole, and no upstream text is
reproduced in the skill, so no `LICENSES/` directory is carried — each adapted upstream is
installed as equipment in its own right, under its own licence, where the core file's
tool-access section names it. Licences follow ADR 579 (adapt only from MIT, Apache-2.0,
BSD, ISC, 0BSD, CC0, CC BY). Commits were pinned 2026-10-21 with
`gh api repos/<owner>/<repo>/commits/HEAD` and `git ls-remote … HEAD` (agreeing).

## Adapted (ideas and structure, rewritten)

| Upstream | Commit | Licence | What was adapted |
| --- | --- | --- | --- |
| [expo/skills](https://github.com/expo/skills) | `3d1ca4e2a3c5ffc14817a85dde0bf1b188e9753d` | MIT | The Expo craft map itself: project structure, building native UI, `expo-module` (Swift/Kotlin/TypeScript native modules, config plugins, autolinking), data fetching, deployment, `eas-workflows`, `eas-app-stores` → the craft split in `references/expo-app.md`, `references/native-bridge.md` §1, `references/build-and-release.md`. Installed as equipment, not vendored. |
| [twostraws/SwiftUI-Agent-Skill](https://github.com/twostraws/SwiftUI-Agent-Skill) (`swiftui-pro`) | `ce32af1693b9e78a7d22ff48001c97a304d32063` | MIT | The catalogue of agent failure modes in Swift/SwiftUI (deprecated APIs, state and data-flow mistakes, performance, accessibility) → the Swift discipline in `references/native-bridge.md` §2, applied to module code with no SwiftUI surface. |
| [getsentry/XcodeBuildMCP](https://github.com/getsentry/XcodeBuildMCP) | `d13ff0c707b0681769cf31da0eb42c4f94ceafff` | MIT | The headless build–run–test–screenshot–debug loop as the native verification shape → core tool access and `references/testing-and-verification.md` §2. A tool surveyed, not text adapted. |
| [mobile-dev-inc/Maestro](https://github.com/mobile-dev-inc/Maestro) | `028c18b9ce7441c117f161da4dfe8007e46fa61d` | Apache-2.0 | Repeatable YAML flows as the kept form of a verified behaviour, and its built-in MCP as agent equipment → `references/testing-and-verification.md` §2. No `NOTICE` file is carried because no Maestro text is reproduced. |

## Cited only

- [AvdLee/SwiftUI-Agent-Skill](https://github.com/AvdLee/SwiftUI-Agent-Skill) (`204dba7c67256a8b707ee3fbc5759a824191974f`, MIT): a second SwiftUI skill surveyed; its concurrency/performance emphases corroborate `swiftui-pro`. Not adapted — one Swift source is enough.
- [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) (`063bee94c3f4df8453406c830b0a7df0f2860278`, licence unstated at root): `vercel-react-native-skills` performance rules cited as practice in `references/research.md` §2. Reference-only until its licence is stated.
- [callstackincubator/agent-skills](https://github.com/callstackincubator/agent-skills) (`59e9d17446a248b21d86f078fcd0bd2d36db1ca4`): React Native best-practices skill surveyed for the performance craft; cited in `references/research.md` §2.
- [dpearson2699/swift-ios-skills](https://github.com/dpearson2699/swift-ios-skills): the broadest iOS skill set (CryptoKit/Secure Enclave included), licence NOASSERTION — read and cited only under ADR 579, nothing adapted.
- Apple's developer documentation (CryptoKit, Secure Enclave, App Attest, notification extensions, Keychain, App Transport Security, Human Interface Guidelines) and Expo's documentation (https://docs.expo.dev/mcp/ and the pinned SDK docs): primary sources, cited where used, never copied.
- Xcode 26.3 agentic coding and its built-in MCP tools (Apple): surveyed as first-party tool access in `references/research.md` §4.

## Research

One web-research pass and one repository survey by wallow, 2026-10-21, merged in
`references/research.md` — including what was not adopted (a native-Swift-first role,
unstated-licence skill text, default App Store Connect write access, local Xcode builds)
and the two questions only a human can answer. The method's step-2 ideal is one read-only
researcher per craft in parallel; this draft ran them as one merged pass, and
`evals/results.md` records the skill as unproven until the blind run says otherwise.
