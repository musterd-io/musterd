# 764 — The phone app goes Liquid Glass with SF Symbols: expo-glass-effect and expo-symbols

- Status: accepted
- Date: 2026-10-29

## Context

nick asked on 2026-10-24 for the musterd app (`packages/mobile`) to be bleeding edge as well as warm, sleek and a little SaaS: the newest iOS look and platform features, not a generic React Native look (lane `01M5R17GS1`, Away channels 7i). He confirmed it on 2026-10-29. ADR 760 already brought in DM Sans and haptics. The cards were still opaque white views, and the app drew its only glyphs as text (a `✓`).

iOS 26 brought Liquid Glass, the system's translucent material. SF Symbols are Apple's icon set, and they match the system type and weight.

## Problem

Neither the material nor the symbols can be reached from core React Native. Expo ships `expo-glass-effect` (`GlassView` on `UIGlassEffect`) and `expo-symbols` (`SymbolView` on `UIImage(systemName:)`) for SDK 58. Each is a runtime dependency, so hard rule 6 requires an ADR.

## Decision

1. The app takes `expo-glass-effect` (`~58.0.5`). `src/ui/glass.tsx`'s `Glass` draws a card as a regular, light-scheme `GlassView` when `isLiquidGlassAvailable()` is true. Otherwise it is the solid white card with hairline border and soft shadow the app drew before, in the same shape. The asks-list rows and the descriptor card use it. `Backdrop` puts two soft mustard-50 and sand discs behind the top of a screen, so the glass has colour to bend.
2. The app takes `expo-symbols` (`~58.0.4`). `src/ui/icon.tsx`'s `Icon` draws an SF Symbol in the text's colour, with a text fallback. The symbols are `faceid` on the Face ID chips and the Approve with Face ID button, `qrcode.viewfinder` on the pair button, and `checkmark` with a bounce on the answer-sent moment.
3. "Decline — I did not expect this" gives a warning haptic (`expo-haptics`, ADR 760) as it is pressed.
4. Every word the app shows stays as it was: the descriptor wording, the Face ID copy and the security text are unchanged. Only the material and the glyphs change.

Alternatives considered: core RN's `View` with translucency and a background colour, which is not glass and does not refract; `expo-blur`'s `BlurView`, the older system blur, which is a separate dependency and is not Liquid Glass; drawing icons as text or images, which needs no dependency but does not match SF Pro's weight and drops the system's symbol animations.

## Consequences

- On iOS 26 the list and descriptor cards are glass over the warm backdrop. On an older iOS they look as they did before.
- A new card in the app uses `Glass` instead of hand-rolling a white `View`.
- `colorScheme="light"` is pinned because the app is light only (lane `01M64DZDVE`). If the app ever follows dark mode, the glass's scheme must follow it too.

## Observability & Evaluation

n/a — no agent-facing behaviour changes. nick judges the look on the TestFlight build that carries it.
