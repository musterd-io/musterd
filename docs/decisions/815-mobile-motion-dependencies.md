# 815 — Motion on the phone: reanimated, worklets, gesture-handler and svg

- Status: accepted
- Date: 2026-11-05
- Lane: `01M6Q59ESA60Y0FF8BXC5W9ETW` (task 4 of
  [the phase 1 plan](../superpowers/plans/2026-11-05-app-shell-now.md)).

## Context

The app's motion so far is React Native's own `Animated` (`src/ui/motion.tsx`: Rise, Squish,
Breathe, Pop, Halo), which was enough for a list that rises in and a button that gives under the
finger. [The app shell design](../superpowers/specs/2026-11-05-app-shell-design.md) asks for more:
a floating tab pill whose icon springs on press, a member sheet that rises on a spring and is
dragged shut, rows that slide into a new order when the roster changes, and nick's bar for all of
it: "every button click, every action, navigation, transitions needs to feel so extremely magical,
fun, smooth, sleek, warm and responsive". He named movetrail's tab bar
(`~/movetrail/app/src/components/CustomTabBar.tsx`) as the reference; it is built on
`react-native-reanimated` and `expo-linear-gradient` with phosphor icons.

Hard rule 6: a new runtime dependency needs an ADR naming why and the alternative considered.

## Problem

`Animated` with `useNativeDriver` can move opacity and transforms off the JS thread, but it cannot
run a gesture-driven sheet there (the drag's position would round-trip through JS every frame),
cannot animate layout (a row sliding to a new index), and its springs cannot be composed into the
squash-overshoot-settle sequence the pill needs without chaining three callbacks on the JS thread.
A JS-thread animation stutters the moment a roster parse or a portrait decode lands, which is
exactly when the Now screen re-sorts. The app also has no way to draw a gradient or an icon of its
own: `expo-symbols` draws SF Symbols only, and the pill's three glyphs are not in SF Symbols.

## Decision

1. The app takes `react-native-reanimated` (4.7.1) and its peer `react-native-worklets` (0.13.0).
   Every spring in the app shell runs as a worklet on the UI thread: the pill's icon bounce, the
   sheet's rise and drag, press squash, and the Now list's layout transition when it re-sorts.
   `src/ui/motion.tsx` stays as it is for the screens that already use it; the new shell's motion
   is written on reanimated, and `motion.tsx` moves over when a screen is rewritten, not before.
   The babel plugin `react-native-worklets/plugin` is last in `babel.config.js`.
2. The app takes `react-native-gesture-handler` (~3.3.0), for the member sheet's drag-to-dismiss.
   `GestureHandlerRootView` wraps the app in `src/app/_layout.tsx`.
3. The app takes `react-native-svg` (15.16.0), for the pill's three tab icons, the active tab's
   gradient capsule and the page's warm glow. Gradients and icons the app owns are drawn in SVG; SF
   Symbols through `expo-symbols` stay for system glyphs.
4. Nothing else. No `expo-linear-gradient` (SVG draws the two gradients), no phosphor (three icons
   do not justify an icon set), no `expo-blur` (`expo-glass-effect` is the app's material, ADR 764).

Alternatives considered: `Animated` alone (above: no UI-thread gestures or layout animation);
`react-native-reanimated` without `gesture-handler`, using `PanResponder` for the sheet (JS-thread
drag, the stutter this decision exists to remove); `expo-linear-gradient` plus phosphor as movetrail
has them (two dependencies for what `react-native-svg` draws, and the app would carry an icon set
for three glyphs); Moti or a sheet library on top of reanimated (one more layer over the same
primitives, and the sheet is one component).

## Consequences

- Four native modules join the build. The TestFlight run's pod list carries `RNReanimated`,
  `RNWorklets`, `RNGestureHandler` and `RNSVG`; `expo doctor` stays 20/20 (these are SDK-bundled
  and pinned at the versions `expo install` chooses, which the SDK-floor guard in
  `tests/dependency-guards.test.ts` holds).
- Reduce Motion is honoured as before: the shell reads `useReduceMotion()` and uses
  `withTiming(…, { duration: 0 })` in place of each spring.
- The app's bundle grows by reanimated's runtime; the New Architecture is already on (ADR 520), so
  no bridge shim is added.

## Observability & Evaluation

- Traces: n/a — a build-time dependency. The TestFlight run log's `[INSTALL_PODS]` lines are the
  record that the four modules linked.
- Eval: n/a. Not agent-facing.
- Experiment: falsified if a TestFlight build after this ADR crashes at launch on a missing worklets
  symbol, or if the Now screen's re-sort drops frames in a screen recording on nick's phone where
  the same list under `Animated` did not.
