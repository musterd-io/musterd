# 625. /broadcast repaints only what changed, and its residue is measured, not zero

- Status: accepted
- Date: 2026-10-15
- Lane: `01M4VS1SJQ` (smooth-capture increment 3). Spec: [`2026-10-13-broadcast-smooth-capture-design.md`](../superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md), lever 2.

## Context

The stream's room is drawn by a single thread, and drawing is the wall: on the Fly `performance-4x`, x11grab capture left a third of the box idle while draws held at ~18/s against a bar of 30 ([`broadcast-baseline.md`](../perf/broadcast-baseline.md), 2026-10-14). The spec's lever 2 is to repaint only what changed. It wrote the partial frame as "meant to be byte-identical to a full one", and named `scene-pixel-check` as the instrument.

Measured on 1920×1028 `/office-preview` (2026-10-15): the share of 32-px tiles that change between consecutive frames is 4% (p50) in a seated room and 7% (p50, p90 10%) under the looping choreography. One bounding box around all of it is 25–28%, so the saving is in many small rects, not one.

## Problem

Two findings broke the spec's premises.

1. **Chrome cannot make a partial frame byte-identical.** When a clip edge cuts an antialiased path, Skia rasterizes that path's edges differently *inside* the clip: one path, 895 bytes differing, max Δ41, against 0 when the path lies wholly within the clip. A scratch canvas the size of the rect behaves the same (its device bounds cut the path). Growing each rect until no small unit crosses its edge cascades across the furnished room to a full frame every time. So no clip- or region-based repaint is byte-exact on this renderer.
2. **Measuring every unit costs the JS the room spends drawing.** Most of the uncached paint was static furniture drawn live (chairs ~3,800 calls a frame, desk near-halves ~1,000, the meeting set, the nook), and a measure pass replays all of it. At 4× CPU throttle that added ~16 ms per draw and cancelled the raster saving.

## Decision

1. **Dirty-rect repaint on `/broadcast`**, behind the sprite cache's switch (`&sprites=0` turns both off) with its own escape hatch, `&dirty=0`. `/live` is unchanged. Each frame:
   - **Measure.** The room's paint sequence runs as units (every depth item and sprite part, every layer around the loop: shell, wall fixtures one by one, beams, rugs, the night veil, the lamps, each member's glow, pills, vignette, cues) into a recording context that rasterizes nothing. A unit's key hashes the context state it inherits (including any open path it paints with) and every call it makes; its box is the device extent it paints, grown for strokes.
   - **Diff.** Damage is the box of every key new this frame and of every key gone since the last. Rects merge to ≤ 16; past half the canvas the frame paints whole.
   - **Paint.** Clip to the rects, clear them, run the sequence again, skipping a unit only when it is *neutral* (leaves the state as it found it) and cannot touch a rect.
   - **Heal.** A whole frame on the first paint, after a resting blit, on resize, and at least every 5 s.
   - Every painted frame starts from the 2D defaults. Before this, a frame inherited the last one's leftovers (round line joins at the wall board's corners), so the stage's first frame differed from every later one.
2. **The residue is accepted as measured** (nick, 2026-10-15, in session), as ADR 488 accepted the sprite cache's. Over four moving rooms × 20 s the worst frame differed in 134 bytes (≈ 35 px of 2 M), max Δ53, and the count stays flat rather than accumulating. `scene-pixel-check --dirty` reports it, and fails only on what a person would see: a frame over 1,200 differing bytes (a stale patch), Δ > 80 (an object's colour left behind), more than 15 bytes beyond one step per frame, or a residue that builds up. During the check the 5 s safety repaint is paused so a missed damage accumulates where it shows. Against a deliberately broken build (no old positions, no pad) it faults three of four rooms.
3. **Static furniture becomes sprite parts**: desk near-halves, desk chairs *at rest* (a roll-back or swivel paints live until it ends), the meeting table and chairs, the printer, the nook pieces (the fridge keyed on its door), and reception's end table, armchair and plant. Each key carries the fit, dpr and palette plus whatever else the piece reads. This cuts the measure pass and also the JS and raster of today's stream, dirty rects or not.

## Consequences

- Laptop numbers only — mac headless Chrome, `--disable-gpu`, 4× CPU throttle, 15 s windows, two rounds. Main-thread task ms per draw: seated room 169/144 direct → 82/74 sprites → 41/57 dirty; choreographed room 122/118 → 66/86 → 55/80. Draws/s rose with each step. The box is the authority: increment 4 (`01M4VS22F1`) measures this against the 30 fps bar on the bench and then live.
- [`canvas-raster-vs-js.md`](../wiki/canvas-raster-vs-js.md) (2026-09-18) holds that ~34 of ~51 ms per draw is area-independent Skia cost, so clipping alone cannot reach 20 fps. This build skips the units outside the damage as well as clipping, which removes their per-op cost too; whether that is enough is increment 4's reading, not this ADR's.
- The sprite gate's residue (`scene-pixel-check`, no flag) grows with the new sprites: ≈ 3,600 more pixels beyond one step at noon, desk near-halves the largest share (2,136), no new worst delta (≤ 54 against the existing 100). It stays a person's call, as ADR 488 left it.
- The recorder is a plain object, not a Proxy, and implements the context calls the room uses. A painter that starts using one it lacks throws in the measure pass instead of drawing — loud, and caught by `damage.test.ts`'s whole-room pass.

## Observability & Evaluation

- **Traces:** n/a — this changes how a canvas paints, not an agent-facing path.
- **Eval:** `scene-pixel-check --dirty` is the correctness instrument, with its failure thresholds above and a sabotage run on record. `__office.stats().repaint` (`px`, `stagePx`, `full`, `partial`, `skipped`) gives the share of the canvas actually repainted on the live stream.
- **Experiment:** `&dirty=0` is the A/B arm on the same box and build. Increment 4 reads draws/s, gap p95 and box CPU with and without it. Falsifier: if on the bench `&dirty=0` and the default draw within 10% of each other over 60 s, the lever bought nothing there and this ADR's premise is wrong for the box.
