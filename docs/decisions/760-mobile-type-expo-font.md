# 760 — The phone app's type and touch: DM Sans and JetBrains Mono through expo-font, feedback through expo-haptics

- Status: accepted
- Date: 2026-10-29

## Context

On 2026-10-29 nick asked for the musterd app (`packages/mobile`) to carry musterd's look: light, branded, and "magical, fun, warm, intuitive, helpful, sleek, smooth, responsive, beautiful, delightful, and a little bit SaaS". Lane `01M64DZDVE` made the app light only, gave it the ADR 702 mark as its icon and put the ADR 704 nameplate on the Asks title bar. The text was still Apple's system face, and a press gave no touch feedback.

brand.md §3 (ADR 706) names two faces for every surface: DM Sans for words, JetBrains Mono for data. The web commits a latin cut of each as a variable file (`packages/web/src/styles/fonts/`).

## Problem

React Native cannot use a `.woff2`, and iOS fakes a weight it is not given a file for, so the web's variable files cannot be used as they are. Embedding a font in an Expo app needs `expo-font`, and touch feedback needs `expo-haptics`. Both are runtime dependencies the app does not declare, and hard rule 6 requires an ADR for each.

## Decision

1. The app takes `expo-font` (`~58.0.9`, the SDK 58 line already in the lockfile through `expo`) as a direct dependency, used only as its config plugin: the fonts are embedded in the binary at build time, so there is no load step and no flash of the system face.
2. The faces are static TTFs instanced from the web's committed variable files with fontTools, at optical size 14: DM Sans 400, 500, 600, 700 and 780 (brand.md's display weight), and JetBrains Mono 400. Each file has its own PostScript name (`DMSans-SemiBold`, …), and `src/ui/theme.ts` exports them as `font.regular | medium | semibold | bold | display | mono`. A style names a face with `fontFamily` and never sets `fontWeight`. Together they add about 230 KB to the app.
3. The app takes `expo-haptics` (`~58.0.7`) as a direct dependency, behind `src/ui/haptics.ts`: a light impact when a `Squish` press starts, and a success notification when an answer is sent or a phone finishes pairing. A haptics failure is swallowed.

Alternatives considered: the system face (San Francisco), which needs no dependency but leaves the app the one musterd surface that is not in DM Sans; loading the fonts at runtime with `useFonts`, which uses the same package and shows the system face until the load finishes; the variable TTF on iOS, where `fontWeight` does not select the variable instance reliably; React Native's `Vibration`, which has no light impact or success pattern on iOS.

## Consequences

- Every text style in the app uses one of the six faces. A new style that sets `fontWeight` falls back to a synthesized weight, so reviewers look for `fontFamily: font.*`.
- When the web's font files change, the TTFs are instanced again. Nothing checks that the two copies match.
- The empty list and the paired screen show the mark in a breathing mustard-50 halo (`Halo` in `src/ui/motion.tsx`), and the paired screen pops it in with the success buzz.

## Observability & Evaluation

n/a — no agent-facing behaviour changes. Whether the app reads as musterd is judged by nick on the TestFlight build that carries this change.
