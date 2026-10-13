# /broadcast at a steady 30 fps on the CPU box — design

**Status:** approved 2026-10-13: the design in chat section by section, and the written spec by nick.
Plan: [`2026-10-13-broadcast-smooth-capture.md`](../plans/2026-10-13-broadcast-smooth-capture.md). Lane `01M4VR55VNTPDMCCBBEM2G70TB`. Goal: `launch`.

## What nick asked for (2026-10-13)

The stream is "a little choppy"; it has to be extremely smooth. In the brainstorm nick set the bar at a
**steady 30 fps** (not 60, not "whatever looks smooth"), on **today's CPU-only Fly `performance-4x`**
first, with **no drop to 720p**, not even as a stopgap: "let's make the actual fix".

## Why it is choppy (measured)

The stream is 1080p at **15 fps** by design (`fps=15` in the hosted capture's log; ADR 488 set the
target there because the GPU-less box could not hold more). Motion at 15 fps reads as choppy even when
every frame lands. When the room draws under 15/s, the frame pump fills the gaps with repeats, and
that adds stutter.

Two walls stand between that and 30 fps. Both have to come down. The numbers are in
[`docs/perf/broadcast-baseline.md`](../../perf/broadcast-baseline.md):

1. **The capture path.** Chrome JPEG-encodes every 1080p frame for the CDP screencast. ffmpeg decodes
   the JPEG and then encodes with CPU `libx264`. On 2026-10-13 `top -H` on the box put the browser,
   ThreadPool and DevTools (screencast) at ~80% of a core, and the software compositor at another ~90%
   before #2448 halved it.
2. **The room's own draw.** The renderer's main thread spent ~75% of a core drawing ~15 frames a
   second, about 50 ms per draw. 30 fps leaves 33 ms per frame for everything. A free capture path
   alone would cap near 20 fps.

Ruled out on the evidence, so not part of this design:

- **A bigger Fly box.** The compositor is single-thread bound, and more cores sit idle (2026-07-27
  rows).
- **A GPU host as the lever.** An L4 doubled draws (11 → 19.6/s on its own CPU) but still delivered
  ~16 fps at 1080p30, because the capture path saturated its 4 vCPUs (GPU trial row, 2026-10-13).
- **720p.** nick declined it.

## The bar: what "steady 30 fps" means

These are read on Fly `performance-4x` against the synthetic fixture
(`scripts/perf/broadcast-bench-fixture.sh`, 6 seats, an act every 3 s), then on the live stream.

| Measure | Pass | Why this one |
| --- | --- | --- |
| Room draws per second, sustained over 60 s | ≥ 30 | Encoder frames hide padded repeats; draws do not |
| Frame-to-frame gap, p95 | < 40 ms (33 ms ideal) | An average hides stutter; a tail does not |
| Encoder queue growth | flat (≈ 0 KB/s) | The margin metric the harness already reads |
| Draw floor (`DRAW_FLOOR_FPS`, 12/s) | silent | It is the stream's existing alarm |
| Box CPU | some idle left | A saturated box tips over under a busy room |

`scripts/perf/broadcast-baseline.mjs` gains the frame-gap p95. Every lever lands with a before/after
row in the baseline doc, and none lands on argument alone.

## Lever 1: record the screen, do not screencast the page

**What changes:**

- **The capture image** (`scripts/broadcast/hosted.Dockerfile`) gains Xvfb at 1920×1080×24. Chrome runs
  in it as a normal (non-headless) browser, in kiosk mode at the stage size and DPR 1. PulseAudio
  stays as today: Chrome plays into the null sink and ffmpeg reads its monitor (`--audio`).
- **ffmpeg** reads the display directly: `-f x11grab -framerate 30 -video_size 1920x1080 -i :99`, still
  `libx264 -preset veryfast`, with the same bitrate cap, keyframe spacing and sinks. x11grab samples on
  a fixed clock, so the frame pump (`makeFramePump`) and the JPEG pipe retire in this mode.
- **The DevTools connection stays** for everything except frames: reload on rebuild (ADR 548), the
  draw-floor reading, and the relaunch path (ADR 551). Only `Page.startScreencast` stops.
- **The frozen-picture watchdog** today means "no screencast frame for `FRAME_STALL_MS`". It becomes
  "the page's draw counter has not advanced for `FRAME_STALL_MS` while the room is not parked". The
  counter is the same one the draw floor already reads.
- **Selection:** `musterd broadcast --capture x11|screencast`. The default stays `screencast` until a
  box run passes the bar. The flip is an ADR, because it changes the hosted stream's behaviour.

**What it should buy:** it removes the JPEG encode in Chrome, the JPEG decode in ffmpeg and the DevTools
frame traffic. The XShm read of a 1080p frame is a memory copy. This estimate is unmeasured, and
increment 1 measures it before any production code: about 1–1.5 cores freed.

**Risks:**

- Xvfb's software compositing path differs from headless Chrome's. The compositor cost may move rather
  than vanish, and increment 1 is the check on that.
- Kiosk Chrome can show first-run, restore and infobar UI. The profile flags already in `chromeArgs`
  (`--no-first-run`, a fresh `--user-data-dir`) cover most of it. The increment 1 capture is checked by
  eye for any browser chrome in frame.

## Lever 2: repaint only what changed (dirty rects)

This is built after lever 1 is measured, and only if draws are still short of the bar.

Today `renderScene` repaints the whole room every frame in depth order: ~16,500 canvas calls, most of
them sprite-cache blits of static furniture (ADR 488). On a typical frame only a few things change:
walking and idling members, the dog, cues, the clock hands, and some flicker.

- **The damage list.** Anything that moved or changed this frame contributes its previous and current
  device-pixel bounds. Rects are snapped outward to whole pixels and merged into a small set; above a
  count or area threshold they collapse to the whole canvas.
- **The partial repaint.** For each damage rect: `save`, clip to the rect, redraw in the normal depth
  order only the items whose bounds intersect it, then `restore`. Full-canvas layers (window beams,
  vignette, ground shadow, floor glow, the `lighter` composites) intersect every rect, so they are
  redrawn clipped too. The draws are the same on the same pixel grid, so a partial frame is meant to
  be byte-identical to a full one.
- **Full repaint triggers:** first paint, resize, the lighting tick, a wall-board change, a palette
  change, the sprite cache rebuilding, and a periodic safety repaint every few seconds. The safety
  repaint heals any missed damage instead of leaving a ghost.
- **Proof.** A test drives a scripted scene sequence (walks, an idle gesture, a cue, a clock tick) and
  renders every frame both ways, requiring identical pixels. `scene-pixel-check` stays the instrument
  for the live room. The perf JSONL logs repainted area per frame, so the saving is seen, not assumed.
- **Scope.** /broadcast only, behind the sprite cache's existing switch (`&sprites`). /live keeps its
  direct render until the stream has run cleanly on this.

The target is the ≤ 25 ms per draw bar that ADR 488 kept for a faster stream. That leaves room for
30 fps on the main thread. My unmeasured estimate is a 3–5× cut on an ordinary frame, less during a
walk across the room.

## Lever 3: only if still short

This lever is used only if levers 1 and 2 still leave draws short of the bar. The room's drawing would
then move into an `OffscreenCanvas` worker, so it stops sharing the main thread with the page's DOM
work. That is its own design pass, with its own brainstorm and its own measurement. It is named here
so the fallback is known, not planned.

## Increments

All four are under goal `launch`. Each has its own lane; the design lane is `01M4VR55VNTPDMCCBBEM2G70TB`.

1. **Measure lever 1 (no production code).** On a Fly bench box (`broadcast-bench.Dockerfile` plus
   Xvfb), run the harness at 1080p30 with screencast, then with x11grab, using an ad-hoc ffmpeg
   invocation. Record both rows and the frame-gap p95. **Stop rule:** if x11grab frees less than a
   core, stop and rethink before building it. Lane `01M4VS17JXV4G9AVFPB7W7A6ZW`.
2. **Build `--capture x11`.** This covers the CLI capture mode, the hosted image's Xvfb, the
   draw-counter watchdog, relaunch and audio, with unit tests for the ffmpeg argv and the watchdog. The
   default stays screencast. Lane `01M4VS1F2V95QF8KX4YAZKJCEJ`.
3. **Dirty-rect repaint on /broadcast**, with the pixel-identity test and the repainted-area metric.
   Lane `01M4VS1SJQP5362ZHPRCX9F9RK`.
4. **Measure against the bar, on the bench and then on the live stream.** If it passes, write the ADR
   that flips the default to `x11` and set the hosted stream to 30 fps. If it does not, open lever 3
   as its own brainstorm. Lane `01M4VS22F19WBSG5Y82Z4MYW69`.

## Fallback

`--capture screencast` and `&sprites=0` each revert with one flag. Neither the screencast path nor the
full-repaint path is deleted until the stream has run a week cleanly on the new defaults.

## Constraints that apply

- `pnpm perf:check` byte budgets on the web bundle. The damage tracking adds code to the office scene's
  existing chunk, not a new dependency.
- No new runtime dependency. Xvfb is a system package in the capture image, not an npm dependency, and
  the image change is recorded in the flip ADR.
- `chromeArgs` keeps the container flags (`--no-sandbox`, `--disable-dev-shm-usage`) on Linux.
- A Twitch stream key never reaches a log, and `redactSink` covers the new argv as it covers the old.

## Not in scope

GPU hosts, 60 fps, 720p, the director camera (its own brainstorm, paused 2026-10-13), and any change to
/live's rendering.

## Falsifiers

- If increment 1's x11grab arm frees less than a core against the screencast arm on the same box, lever
  1's premise is wrong. Stop there.
- If the pixel-identity test ever passes while the live room shows a trail or a stale patch, the test's
  scripted sequence misses a kind of change. Add that change to the script before anything else.
- If, after levers 1 and 2, the box draws ≥ 30/s on the bench but the live stream's draw floor fires,
  the fixture under-represents the real room. Re-baseline on the live team before going further.
