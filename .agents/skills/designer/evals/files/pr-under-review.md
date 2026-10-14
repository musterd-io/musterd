<!-- Eval input. FICTIONAL pull request and capture notes written for this eval. -->

PR #9001 "office: members wave when an ask arrives" — lane brief: "When an ask is addressed to a
member, that member's character waves once in the office scene, visible at stage size."

Author's notes: tests pass (wave.test.ts asserts the wave frame index advances). Captured with
`chrome --headless --screenshot --window-size=1920,1080`.

Reviewer's own captures (CDP device metrics, after hydration):
- 1920×1080 light: the wave plays for 280 ms; the arm moves 2 px; the speech bubble covers the arm.
- 1920×1080 dark: same; the arm is the same color as the wall behind it.
- 390×844: the scene is scaled down; the wave is not visible at all.
- Reduced motion on: nothing changes when the ask arrives; no static cue replaces the wave.
