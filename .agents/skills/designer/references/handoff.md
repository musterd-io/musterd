# Specs, tokens, design files, capture and budgets

Open when writing a spec or tokens, working from a design file, implementing, capturing a surface
for review, or checking a performance budget.

## 1. A spec an implementer cannot misread

A spec states, for each surface and state: the layout at each breakpoint, the tokens used (never raw
values), every string exactly (from whoever owns voice), the interaction (what each control does,
keyboard included), every state (empty, loading, error, partial, stale), motion (token, trigger,
reduced-motion behavior), and the acceptance check: what a reviewer will see at which size.
An implementer bounces anything ambiguous back instead of guessing.

## 2. Tokens

- Name tokens by role (`color.text.muted`, `motion.duration.short`); a name that encodes the value breaks when the value changes.
- Light and dark are two resolutions of the same names.
- The W3C Design Tokens Community Group format reached its first stable release, 2025.10
  (`.tokens.json`, `$value` and `$type`, aliases as `{group.token}`); pin that version; later
  drafts are marked not for implementation ([DTCG](https://www.designtokens.org/), cited).
- A check that fails when code and tokens drift is worth more than a careful reviewer.

## 3. Working from a design file with an agent

A design tool's MCP server supplies context; the agent writes the code and does not know your
design system unless told. Rules that hold up (after Figma's published guidance, cited): reuse the
design system's components, no hard-coded values, no new icon packages, and compare a screenshot
of the result with the frame before calling it done. Components, variables, named layers and
auto layout in the file make the context far better.

## 4. Capture for review

1. **Real viewport and pixel ratio.** Drive a headless browser over CDP with
   `Emulation.setDeviceMetricsOverride` at each target size. A window-size flag or a dev viewport
   gives a clipped or pre-hydration picture.
2. **Wait for the page to settle**: fonts loaded (`document.fonts.ready`), loading indicators gone,
   live data either real or deliberately fixed.
3. **Every combination that ships**: each size × each theme × reduced motion on and off.
4. **Screenshot tests**: Playwright's `toHaveScreenshot` waits for two identical frames, disables
   CSS animations and hides the caret; baselines are per operating system and browser, so generate
   them in CI. Mask or freeze dynamic data. Set the viewport after any device preset, or the preset
   wins (Playwright docs, cited). Two traps: disabled animations hide motion bugs, so check motion
   separately; and "two identical frames" also matches a page stuck on its loading skeleton.

## 5. Performance as a design constraint

- **Budgets per surface** (initial JavaScript, total JavaScript, CSS, fonts, images) are checked
  before merge; a design that needs a raise argues for it in writing.
- **Core Web Vitals**, judged at the 75th percentile: LCP good at 2.5 s or less, INP at 200 ms or
  less, CLS at 0.1 or less ([web.dev](https://web.dev/articles/vitals), CC BY 4.0).
- **What costs**: every font file and weight, large images (set width and height, lazy-load below
  the fold), blur and backdrop filters, layout reads during animation, lists over about fifty items
  without virtualization.
