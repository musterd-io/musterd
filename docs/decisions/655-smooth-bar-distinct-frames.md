# 655 — The smooth-capture bar counts distinct frames on screen, at about 26 a second

- Status: accepted
- Date: 2026-10-17
- Lane: `01M55MAQ9M`. Spec: [`2026-10-13-broadcast-smooth-capture-design.md`](../superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md). Amends [ADR 642](642-hosted-stream-x11-30fps.md) Decision 2. Decided by nick in chat, 2026-10-17.

## Context

The spec set "steady 30 fps" as ≥ 30 room draws a second and a draw-to-draw gap p95 under 40 ms,
both read inside the page. ADR 642 moved the hosted stream to x11 at 30 as a step and kept that bar
(Decision 2), with lever 3 (an `OffscreenCanvas` worker) still to go after it.

Lane `01M55MAQ9M` measured what lever 3 would reach before building it. The numbers are in
`docs/perf/broadcast-baseline.md`, three sections dated 2026-10-17 ("Lever 3's question", "Compositor
experiments", "GPU host under x11"). They add a viewer-side reading: a fingerprint of every raw grabbed
frame before the encoder, which counts the distinct frames that reach the screen.

| box, configuration | distinct frames/s | repeats | page draws/s | gap p95 |
| --- | --- | --- | --- | --- |
| Fly `performance-4x`, x11 at 30 (the hosted stream) | 25.4–26.3 | 12–15 % | 25–26 | 51–54 ms |
| Fly, faster page (`novsync+page45`) | 23.1–23.6 | 21–23 % | 34–36 | 41–43 ms |
| GCP L4, GPU compositing + NVENC | 26.1–26.5 | 12–13 % | 27.5 | 57–58 ms |

## Problem

The page-side bar does not measure what a viewer sees. A page can draw faster and pass more of it
while fewer distinct frames reach the screen: the faster page above has the best page numbers and
the worst screen. The renderer main thread is not the limit (about 55 % busy), so lever 3 as written
would not reach the screen. The limit is a single-thread stage in Chrome's GPU process. On the CPU box it is
the software compositor (87–98 % of a core). With a GPU it is the GPU process main thread
(91–93 %). Every configuration measured stops at about 26 distinct frames a second.

## Decision

1. **The bar is distinct source frames a second.** It is read with the fingerprint method in
   `scripts/perf/capture-ab.mjs` (`source.distinctPerSec`), on Fly `performance-4x` at 1080p30 against
   the bench fixture, sustained over 60 s.
2. **The pass is ≥ 25 distinct frames a second**, with the encoder holding `speed=1.00x` (flat
   queue), the draw floor silent and some box idle left. nick accepted "about 26" on 2026-10-17. The
   floor of 25 is my call: it sits under the 25.4–26.3 the hosted configuration measures, so a run
   that drops below it is a regression and not noise.
3. **Page draws/s and the gap p95 become diagnostics, not the bar.** The harness still records them,
   because they say where a change acts.
4. **The hosted stream as it runs today (x11 at 30, ADR 642) meets the bar.** The smooth-capture goal
   is met at this bar, and lever 3 is not built.
5. **A GPU host is not adopted.** It lands at the same ~26 for more money (GCP L4 row).

## Consequences

- ADR 642's "the spec's 30 fps bar stands" is amended by this ADR. The stream's configuration does
  not change.
- A change to the room's drawing, the capture or the encoder lands with a distinct-frames row from a
  bench run, not only page draws.
- The ~26 ceiling is Chrome's, not the page's. Passing 30 would need the page to give the GPU process
  less work per frame, or a faster single core. Neither is planned.

## Observability & Evaluation

- **Traces:** n/a. This is a measurement bar for the capture pipeline, not an agent-facing path.
- **Eval:** `scripts/perf/capture-ab.mjs` arms print `source.distinctPerSec` and `source.repeatPct`
  per arm in the `CAPTURE_AB` line; `fly logs` carries them.
- **Experiment:** the three bench runs tabled above, each interleaved on one box. Falsifier: a bench
  run of the hosted configuration on Fly `performance-4x` that reads under 25 distinct frames a
  second on two interleaved arms means the bar sits above what the stream holds, and it is re-read.
