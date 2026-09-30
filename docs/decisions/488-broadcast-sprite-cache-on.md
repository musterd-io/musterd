# 488 — The stream turns the sprite cache on; `/live` keeps the direct render

- Status: accepted
- Date: 2026-09-30
- Deciders: nick (the call, from the on-box diff), miley (lane `01M3STFRSDJC4QACABPD9ZW7PB`)
- Spec: `docs/superpowers/specs/2026-09-17-office-scene-sprite-cache-design.md`
- Relates to: ADR 157 (the broadcast stage), ADR 151 (perf budget)

## Context

The hosted stream's office draws 9-11 frames/s on its GPU-less `performance-4x`. On 2026-09-30
the target moved from 20 to 15 fps (#1881), which at least stopped the draw floor firing. The
sprite cache (#1550) paints the static room once per state and blits it. On the box it measured
57.4 ms/draw against 71.5 without it, about 17.4 draws/s against 14.0.

The spec gated turning it on behind two bars: byte-equal pixels across the gate's matrix, and
≤ 25 ms/draw. Its exit criterion says loosening pixel identity "is a new decision for nick, not a
scope change". On 2026-09-18 nick ruled that it stays dark until something measures under 25 ms.

## Problem

Neither bar can be met by the cache. A blit is a second composite, so byte equality is ruled out
by mechanism ([canvas sprite caching](../wiki/canvas-sprite-caching.md)). 25 ms is out of reach
without dirty-rect damage tracking as well, which is several days in a 4,800-line renderer. The
25 ms bar was sized for 20 fps (a 50 ms budget). At 15 fps the budget is 66 ms, and the cache
alone fits it.

## Decision

**`/broadcast` renders with the sprite cache by default. `&sprites=0` turns it off. `/live` never
passes it, so every viewer's browser keeps the direct render.**

nick took the call on 2026-09-30 from pictures, not numbers alone. The on-box diff at stage size
(#1886) was ~0.16% of a daylight frame beyond one rounding step, and ~0.03% at night. That is a
2-step speckle on the entrance door glass plus beam and edge antialiasing, and one pen cup whose
stem differs at Δ91. Nothing lands on a face or a nameplate.

The ≤ 25 ms bar is not dropped. It remains the bar for a 20 fps stream, and dirty-rect damage
tracking is how to reach it.

## Consequences

- The stream's real draw rate should rise from ~10/s toward the 15 fps target. The draw floor
  (`DRAW_FLOOR_FPS` = 12) is the check: it should stay quiet.
- It ships as a web change, so it reaches the stream on the next page load through the normal
  publisher. No capture-image rebuild is needed.
- `scene-pixel-check` stays red by design (it fails on any difference). It remains the instrument
  for any change to the cache, read as "did the residue grow", not as "is it zero".
- `/live` is unaffected, and a viewer with a GPU gains little from the cache anyway (#1550).

## Observability & Evaluation

**Traces.** No new trace. The reading is the capture's own draw floor ("the office drew N
frames/s …") in `fly logs -a musterd-broadcast`, plus `drawFps` in the perf JSONL when
`MUSTERD_BROADCAST_PERF` is set.

**Eval.** Baseline: at 15 fps without sprites (2026-09-30) the floor fired on relaunch windows at
9-11 frames/s. Falsifier: over any 24 h of the hosted stream after this ships, the floor fires as
often as that or more. That would mean the cache bought nothing on the box, and it is reverted
with `&sprites=0`.

**Experiment.** n/a — the A/B arm already exists (`&sprites=0` on the same page, interleaved,
#1564). A new one is only warranted if the falsifier trips.
