# Broadcast capture-pipeline baseline — `musterd broadcast`

**Date:** 2026-07-25 · **Commit:** _harness landed; numbers pending_ · **Author:** miley

The capture pipeline is the one musterd surface with no measured margin. On a quiet machine it holds
~0.99× real time; under the load this box routinely carries it falls behind until the ADR 159 stall
watchdog ends the stream. This is the baseline log for it, in the house shape used by
`web-live-baseline.md`: **reproducible method → baseline tables → dated optimization log → an
explicit "deliberately not done" list.**

Plan: `docs/superpowers/plans/2026-07-25-broadcast-capture-perf.md`. Prior art: ADR 157 (broadcast
mode), ADR 159 (stop path + stall watchdog).

> **Status: the harness is built, the numbers are not taken.** The tables below are deliberately
> empty. Every measurement in the session that produced this plan was contaminated — load swung
> between 5 and 63 as other sessions built — and a contaminated baseline is worse than no baseline,
> because it looks like data. Fill these in from a quiet machine.

## Method (reproducible)

```sh
pnpm build
node scripts/perf/broadcast-baseline.mjs --label "1080p30 (today)" --fps 30 --secs 60
```

The harness sets `MUSTERD_BROADCAST_PERF=<scratch>.jsonl`, runs a real `musterd broadcast` to a temp
`.mp4` it then deletes, and summarizes the samples with the recorder's own tested code
(`packages/cli/dist/commands/broadcast-perf.js`) so the harness cannot drift from the numbers. It
**refuses to run above load average 2.0** (`QUIET_LOAD_MAX`); `--force` overrides, and the summary is
stamped `contaminated` either way. It exits non-zero on a contaminated run.

The instrumentation ships inert: with `MUSTERD_BROADCAST_PERF` unset there are no CDP round-trips, no
per-second `ps` fork, and no file handle — the `?beat=` precedent. Per-sample fields are documented on
`PerfSample` in `packages/cli/src/commands/broadcast-perf.ts`.

### Read the queue, not `speed=`

**`speed=` is pinned at ≈1× by construction for a live source.** The pump feeds ffmpeg on a wall
clock, so `speed=` reports only whether the encoder kept up, never by how much it _could_ have.
Captures at 30/20/15 fps all returned ~1.0×, which reads like "fps makes no difference" and means
nothing of the sort. **Queue growth rate (KB/s) is the margin metric** — a pipeline with headroom
holds a flat queue, one without grows one.

## Baseline numbers

These rows stood as em-dashes from 2026-07-25 to 2026-09-15 — the table was written, the harness was
built, and nobody ran it. 720p was chosen on the #369 spot measurement and the hosting-spec run D
instead, so the setting that governs what every viewer sees was picked without the comparison this
document asked for. Two arms are now measured; the other two remain unrun and are marked as such.

**Measured 2026-09-15 on the live `musterd-broadcast` performance-4x machine** — the real box, the
real room, libx264, not the local harness (a Mac composites at a true 60Hz with VideoToolbox and its
numbers do not transfer to a GPU-less Linux box). Read from ffmpeg's own `-stats`, which Fly emits as
one line when the capture ends.

| Config            | delivered fps | speed      | bitrate      | px/frame  | held for |
| ----------------- | ------------- | ---------- | ------------ | --------- | -------- |
| 720p25 (was)      | 25.0          | 1.00x      | ~2900 kbit/s | 0.92M     | 14 min   |
| **1080p15 (now)** | **15.0**      | **1.00x**  | ~3334 kbit/s | **2.07M** | 45 min   |
| 1080p20 (was)     | 20.0          | 0.998x     | ~3517 kbit/s | 2.07M     | 6.5 min  |
| 1080p30           | —             | —          | —            | 2.07M     | unrun (10.2 fps delivered, July spot check) |

**Every 1080p arm sustains real time, so the box was never the reason for 720p.** `speed` is ffmpeg's
own ratio against wall clock; below 1.0 is the viewer-buffering failure mode.

**1080p20 is the first arm that is not cleanly 1.00x**, and that is recorded rather than rounded:
0.998x is ~7 s of lag per hour, which the drift-compensating pump absorbs by design (see
`makeFramePump`), but it places this rung near the box's limit rather than inside it. Re-measure it
first if viewers ever report buffering. 1080p15 is the fallback with real headroom.

**Why resolution mattered more than frame rate.** This channel gets no Twitch transcode — the quality
menu carries a single entry — so a 720p ingest was upscaled to a 1080p surface on every viewer's
screen. The spatial gain is certain: 2.25x the pixels and no upscale. The frame rate was settled by
eye, not by the numbers — 15 read crisper but choppy on a walk; 20 read right (nick, 2026-09-15).

**2026-09-30 — back to 1080p15** (nick; lane 01M3STFRSD). The 20 above was judged against a 20 the
box never delivered. `fps` in this table is what ffmpeg *emitted*, and the pump re-emits the latest
frame on a wall clock, so it reads 20 whatever the page draws. The office itself draws 9-11 frames/s
on the hosted performance-4x: the draw floor (`DRAW_FLOOR_FPS` = 12) reported 9.x and 10.x on every
relaunch that day, i.e. roughly half of each 20 fps second was repeats. At 15 the same real motion
arrives in fewer padded frames, and the capture's share of the CPU drops. Raising the real draw rate
is the scene's job, not this table's ([broadcast stream](../wiki/broadcast-stream.md)). The floor
stays 12: it is an absolute draw rate and still fires while the room draws fewer.

**2026-10-12 — the box is the bottleneck again, and the encoder's preset was the lever** (miley;
lane 01M4S7YV4TQ0DV8DYPP3DTV2G0; falsify: on a machine built from this lane, `fly machine exec … top -bn1`
on a live 1080p15 stream shows ffmpeg above 100% CPU or the draw floor still reporting under 12/s).
Nick saw the stream slow. On machine `2861422c319218` (performance-4x, 39 min up): load average 6.0
on 4 vCPUs with 0% idle; `ffmpeg` at 140% CPU, Chrome's three processes at ~200% between them; the
draw floor logged `the office drew 8.7 frames/s over the last 70s, under the 12/s floor` — 58% of
15fps — while `speed=` read 0.98-1.00x, exactly the padded-repeats mode the floor exists to name.
The laptop, the tailnet (9 ms direct) and the daemon (`/health` 3 ms) were all clear; the page
itself drew at 60/s on a Mac. The 2026-09-15 rows above were taken before the claim walk, the pin
walk, the denser team cards and the card-wall rework, each a raster cost on a GPU-less box, so the
room's draw cost grew into the encoder's share. libx264 ran at its default `medium` preset until
this lane; it now runs `-preset veryfast` (same `-b:v`/`-maxrate`, so the bits are capped either
way), which is the cheapest third of a core to give back to Chrome. The after-numbers on the box go
here once the image is rebuilt and the stream relaunched; 720p stays the next lever if the floor
still does not hold.

**After (same day, machine `683e6e3fe3e038`, image `9d6a43c3feaa`, 3 min up, #2433 landed):**

| process               | before (medium) | after (veryfast) |
| --------------------- | --------------- | ---------------- |
| ffmpeg                | 140% CPU        | 33% CPU          |
| Chrome (3 processes)  | ~200%           | ~213%            |
| idle                  | 0%              | 33%              |
| load average (1 min)  | 6.0             | 3.7 (still settling from launch) |
| draw floor            | 8.7/s at 70 s   | no floor line in the first 4 min |

`ps` on the box shows `-preset veryfast` in the running ffmpeg. The encoder gave back about a core,
Chrome took some of it, and the draw floor that fired at 70 s on the old machine has not fired. The
longer-run draw rate is not yet measured; read the next `the office drew` line in `fly logs`, if one
comes, before calling the floor held. ffmpeg's `-stats` line arrives only when Fly flushes it, so
`speed=` for this run is unread too.

**2026-10-13 — the box's cost is the compositor, not the canvas; DOM animations now step at the draw cadence** (miley;
lane 01M4S96VAWC5N3M5FGC4H6A75C; falsify: on a machine built from this lane, `top -H` on a live
1080p15 stream shows the `VizCompositor` thread still near 90%, or the local A/B below no longer
separates the arms). Nick asked which of the last two weeks' office changes made the room dear to
draw. Canvas ops per draw on `/broadcast` at 1920×1080, same room, counted with a
`CanvasRenderingContext2D.prototype` wrapper: 09-28 **33,640**, 09-30 (sprite cache, ADR 488)
**16,827**, 10-12 **16,546**. DOM nodes 476 → 434, 57 running CSS animations at both ends. So the
canvas got cheaper, not dearer, and the room was already under the 12/s floor on 09-30 (above). On
the box, `top -H` named the cost: the GPU process main thread 94% and `VizCompositor` 88%, the
renderer main (canvas + JS) 75%, browser + ThreadPool + DevTools (screencast) ~80%. The software
compositor composes a frame whenever the page is damaged, and 55 forever-running CSS animations
(18 steam wisps, 24 motes, 12 twinkles, fan, asks-breathe) damaged it at the display's 60Hz over a
canvas that changes 15 times a second.

A/B/A on this laptop, headless Chrome with `--disable-gpu` (software Viz like the box), the daemon's
`/broadcast?fps=15`, 20 s windows, `ps` %CPU per Chrome process:

| arm | GPU process | renderer | draws/s |
| --- | --- | --- | --- |
| main, animations running | 99%, 100% | 65%, 56% | 16.2, 15.6 |
| main, `document.getAnimations().forEach(a => a.pause())` | 33% | 44% | 15.8 |
| this lane (`office-scene/domCadence.ts`), animations stepped per draw | 50% | 47% | 15.4 |
| this lane, animations forced back to free-running | 92% | 53% | 15.5 |

The lane pauses every animation the page runs and advances `currentTime` by the wall time each drawn
frame covers, right before the canvas draws, broadcast only. The props move at the rate the stream can
show and the compositor gets one damage per draw.

**On the box (2026-10-13 02:08–02:16Z, machine `683e6e3fe3e038`, 2 h 18 min up, bundle 88afd724e
picked up by the page's own build-sync reload):** read through Chrome's debug port on the box,
`__office.stats()` over 30 s: **15.0 draws/s** — the full capture rate, against 8.7/s under the
12/s floor on the morning's machine — with 56 of 57 DOM animations held paused by the cadence and 0
running. `top -H` one-shot: `VizCompositor` 88% → 81%, GPU main 94% → 81%, renderer 75% → 88%,
1-min load 4.0 → 2.7. The thread shares moved less than the laptop A/B (a single sample, and the
renderer now draws 15 frames where it drew 8.7), but the number that matters moved all the way: the
room draws at the stream's rate. The floor's `the office drew` line has not fired since the
veryfast relaunch.

**What the first row is expected to show,** from #369's spot measurement: delivered ~35 fps at
~181 KB/frame, canvas drawing at ~60, so **draws/delivered ≈ 1.7–2.0**. If that holds, the page is
being painted roughly twice for every frame that reaches the encoder, and the plan's candidate #1 is
live. If it does not hold, candidate #1 is dead and the next lever is 720p.

## Rented hardware (Increment 0 run D — Fly `performance-4x`, sjc, 2026-07-27)

Full context and verdict in the hosting spec
(`docs/superpowers/specs/2026-07-26-broadcast-hosting-design.md`). Method: the same harness against
a 6-seat synthetic fixture (`scripts/perf/broadcast-bench-fixture.sh`), daemon local to the box, all
runs quiet.

| Config | delivered fps | draw fps | encoded | queue growth | chrome % | ffmpeg % | pipeline % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| fly 1080p30 libx264 | 10.2 | 19.2 | 30.0 | 0.5 KB/s | 177.4 | 80.7 | 267.9 |
| fly 1080p30 repeat | 10.6 | 20.8 | 30.0 | −1.1 KB/s | — | — | — |
| fly 1080p30 `--disable-gpu` | 10.3 | 20.2 | 30.0 | −0.3 KB/s | 186.5 | 85.4 | 282.1 |

Readings: `libx264` on a dedicated x86 core is ~0.85 core with a flat queue (fine); the compositor
holds ~20 Hz, not 60, because one Chrome thread pegs a core while three idle (fatal — delivery is
~10 fps padded to 30 with duplicates). Single-thread speed, not cores, is the capture's real
requirement; more/bigger cloud does not help, and `--disable-gpu` moves nothing.

The 720p arm (same box, same fixture, after PR #407 added `--resolution`):

| Config | delivered fps | draw fps | encoded | queue growth | chrome % | ffmpeg % |
| --- | --- | --- | --- | --- | --- | --- |
| fly 720p30, skip-from-60Hz | 14.0 | 27.6 | 30.0 | −1.3 KB/s | 132.9 | 41.3 |
| fly 720p30, every frame | 26.5 | 25.1 | 30.0 | −1.6 KB/s | 209.4 | 58.0 |
| **fly 720p25, every frame** | **27.4** | 26.4 | **25.0** | 0.0 KB/s (peak 0.00 MB) | 211.8 | 49.7 |

Two findings: 720p halves both Chrome's raster and ffmpeg's encode; and `everyNthFrame` derived
from an assumed 60Hz compositor was discarding half of a ~26Hz software compositor's frames —
delivery 14 → 26.5 at identical render cost when the skip was removed. `compositorHz()` is now a
platform fact (60 darwin / 30 elsewhere). **720p25 is the first configuration that passes on
rentable hardware**: delivery above the encode rate, flat-zero queue.

(The Air's own opportunistic `libx264` arm was contaminated — other processes 266% — and is recorded
only directionally: ffmpeg ~102%, queue +502 KB/s, delivered 22.4. The Air cannot software-encode
1080p30 either.)

## GPU host trial (GCP `g2-standard-4` + NVIDIA L4, us-west1-a, 2026-10-13)

nick asked for an "extremely smooth" stream, and whether a bigger box would do it (lane
`01M4VPAP852MDQZN7E57R1K6B9`; falsify: a run of this harness on a GPU host whose capture path is
unchanged delivers ≥ 30 fps at 1080p30 with a flat queue). A bigger Fly CPU box was already ruled out
by the 2026-07-27 rows above: the compositor is single-thread bound. So the trial asked whether
hardware compositing changes that. Method: the same fixture and harness as run D, on a spot VM that
deleted itself after an hour (it was torn down after about 25 minutes). The repo at `b00c3fc`; the
only change was an env-injected set of Chrome flags in the VM's own `dist`.

Making headless Chrome use the GPU on this image took three things that a capture image would also
need. The Ubuntu accelerator image ships a compute-only driver, so `libnvidia-gl-580-server` (pinned
to the kernel module's version) plus the glvnd loaders `libegl1 libgles2 libglx0 libopengl0` are
required. ANGLE's Vulkan backend still fell back to SwiftShader. The working path was
`--enable-gpu --ignore-gpu-blocklist --use-gl=angle --use-angle=gl-egl`, which WebGL then reported
as `ANGLE (NVIDIA Corporation, NVIDIA L4/PCIe/SSE2, OpenGL ES 3.2)`. Debian's `/usr/bin/chromium` was
symlinked to Google Chrome 155, so this box ran a different browser build from the Fly image.

| Config (same L4 box) | delivered fps | draw fps | encoded | queue growth | chrome % | ffmpeg % | pipeline % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CPU render, 1080p15 (the stream's config) | 5.6 | 11.0 | 15.0 | 0.0 KB/s | 202.9 | 65.2 | 275.2 |
| GPU render, 1080p30 | 16.3 | 19.6 | 30.0 | 161.7 KB/s | 232.0 | 99.6 | 344.9 |
| GPU render + forced GPU raster, 1080p30 | 16.2 | 19.6 | 30.0 | 199.6 KB/s | 239.6 | 102.2 | — |
| GPU render, 1080p60 | — | — | — | aborted | — | — | — |

The 1080p60 arm hit the encoder watchdog after about 16 s (`speed=0.39x`, 256 MB queued).

Readings:

- **The GPU roughly doubles the draw rate, and that is all it does.** Draws went from 11 to 19.6/s on
  the same box. That is short of 30, and well short of 60.
- **Chrome still burns 2.3 cores with the GPU in use.** Forcing GPU rasterisation moved nothing, so
  what remains is not raster. It is the renderer's main thread (canvas commands and JS) and the
  screencast, which JPEG-encodes every 1080p frame on the CPU. On top of that, ffmpeg decodes JPEG
  and runs `libx264` on the CPU, which is a full core at 30 fps. The 4 vCPUs are saturated
  (pipeline 345%), and the queue grows.
- **The g2's CPU is slower than Fly's.** The CPU arm drew 11/s here against the ~15/s the stream holds
  on `performance-4x`, so a GPU box with the same capture path is a sideways move for the hosted
  stream, not a fix.

**Verdict:** a GPU host does not make the stream smooth while the capture path stays
screencast → JPEG → CPU `libx264`. The cost that is left is the capture path itself. Smoothness
needs that path changed: frames taken from the page's own canvas rather than a JPEG screencast of
the page, and a hardware encoder. That is a design question for the stream, not a hosting one. The
quota grant (`GPUS_ALL_REGIONS` = 1 on `izzocam`) stays in place for a re-run once the path has
changed.

## Capture A/B — screencast vs Xvfb `x11grab` (Fly `performance-4x`, sjc, 2026-10-13)

Increment 1 of the smooth-capture spec (lane `01M4VS17JXV4G9AVFPB7W7A6ZW`;
`scripts/perf/capture-ab.mjs`, self-driving on the bench image; falsify: a re-run of the same script
on the same machine size separates the arms by under 30 percentage points of pipeline CPU). It was
1080p at `fps=30` on the synthetic fixture, with 7 seats online, 60 s windows, run in the order S, X, S.
Draws and gaps come from one in-page probe, and CPU from `/proc` utime+stime deltas per process tree.

| arm | draws/s | gap p50 ms | gap p95 ms | chrome % | ffmpeg % | xvfb % | cli % | pipeline % | box idle % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| screencast#1 | 13.7 | 65.4 | 132.3 | 221.4 | 94.6 | — | 7.8 | 323.8 | 11.8 |
| x11grab | 15.4 | 61.4 | 88.8 | 175.7 | 83.3 | 6.2 | — | 265.2 | 27.1 |
| screencast#2 | 13.8 | 66.4 | 126.9 | 221.9 | 92.3 | — | 8.1 | 322.3 | 12.3 |

Readings:

- **x11grab freed ~58 percentage points of pipeline CPU** (323 → 265) and tightened the p95 gap from
  ~130 to 89 ms. That is under the spec's one-core stop rule, so lever 1 alone does not clear the
  bar.
- **The room's draw is the wall.** With x11grab the box sat 27% idle, yet draws held at ~15/s. The
  limit is now a single thread (the renderer's main thread, or the compositor), not total CPU. That
  makes the spec's lever 2 (dirty-rect repaint) the first lever, not the second.
- The eye-check frame from the x11 arm was clean: no browser chrome, infobar or restore bubble in
  frame.

Per the stop rule, the next move is a rethink with nick (2026-10-14), not increment 2.

## Capture A/B re-run after the sprite-cache fix (Fly `performance-4x`, sjc, 2026-10-14)

The same script and box as the 2026-10-13 run, on a build with #2568 (the sprite cache measures each
item once) and ADR 594 (the capturer hands the page its observer — ADR 580 had stopped every
broadcast from connecting). Lane `01M4YD9AMFS2MS6RZQ2HKSDNFK`; falsify: a re-run on the same build
and box size puts screencast under 15 draws/s.

| arm | draws/s | gap p50 ms | gap p95 ms | chrome % | ffmpeg % | xvfb % | cli % | pipeline % | box idle % |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| screencast#1 | 17.0 | 55.3 | 91.8 | 225.7 | 79.5 | — | 8.1 | 313.3 | 16.0 |
| x11grab | 18.4 | 52.4 | 67.3 | 167.7 | 72.9 | 4.7 | — | 245.3 | 33.1 |
| screencast#2 | 16.8 | 56.2 | 92.5 | 226.9 | 80.1 | — | 8.4 | 315.4 | 15.5 |

Readings:

- **The sprite-cache fix bought about a fifth more draws** on both paths (screencast 13.7 → ~17,
  x11grab 15.4 → 18.4) and cut screencast's p95 gap from ~130 to ~92 ms. An earlier screencast-only
  run on the same build the same evening measured 18.1 and 18.5, so treat ~17–18.5 as the band.
- **It does not clear the bar.** 30 draws/s with a p95 under 40 ms is still well away, and with
  x11grab the box again sat a third idle. The single-thread draw is still the wall, so dirty-rect
  repaint (lane `01M4VS1SJQ`) stays the next lever, ahead of increment 2.

## Dirty-rect repaint, laptop numbers (mac headless Chrome `--disable-gpu`, 4× CPU throttle, 2026-10-15)

Increment 3 of the smooth-capture spec (lane `01M4VS1SJQ`, [ADR 625](../decisions/625-broadcast-dirty-rect-repaint.md)). **Not the bar:** a laptop under 4× throttle stands in for the box's single thread, and other workspaces' builds were running on the same machine, so rounds of the same arm differ by up to ~25%. The bench run is increment 4's. `/office-preview` at 1920×1028, 15 s windows, CDP `Performance.getMetrics` task and script time divided by draws; "sprites" includes the furniture sprites this increment added.

| Room | Arm | Task ms / draw (two rounds) | Script ms / draw | Draws / s | Canvas repainted |
| --- | --- | --- | --- | --- | --- |
| seated (`quiet`) | direct (`sprites=0`) | 169.3 / 143.6 | 26.6 / 21.7 | 5.9 / 7.0 | 100% |
| seated | sprites | 82.1 / 73.9 | 10.6 / 9.2 | 12.2 / 13.5 | 100% |
| seated | sprites + dirty | 40.6 / 56.7 | 14.4 / 19.4 | 22.9 / 17.5 | ~7–10% |
| choreographed | direct | 121.8 / 117.7 | 18.3 / 18.1 | 8.2 / 8.5 | 100% |
| choreographed | sprites | 65.7 / 86.0 | 8.0 / 11.1 | 15.2 / 11.6 | 100% |
| choreographed | sprites + dirty | 55.2 / 79.9 | 14.2 / 22.2 | 18.1 / 12.4 | ~35–40% |

Readings:

- **The measure pass is the cost.** It replays every unit's drawing JS to key and box it; that is the script column's rise. Before the static furniture became sprites the replay cancelled the raster saving outright (seated 79 → 66 ms, choreographed 68 → 79 ms, 2026-10-15 earlier the same day).
- **The choreographed room is the hard case:** `/office-preview`'s loop walks most of the room at once, so a third of the canvas changes per frame. The bench fixture's one act every 3 s sits between the two rooms.
- **Correctness:** `node scripts/perf/scene-pixel-check.mjs <dev> --dirty` — four moving rooms, worst frame 134 differing bytes, max Δ53, flat over the run. A partial frame is never byte-identical on Chrome; ADR 625 records why and the accepted bound.

## Against the 30 fps bar: x11 CLI mode + dirty-rect repaint (Fly `performance-4x`, sjc, 2026-10-17)

Increment 4 of the smooth-capture spec (lane `01M4VS22F1`). `scripts/perf/capture-ab.mjs` on the bench
image, built from `4d9cf6db` (#2784, `--capture x11`; dirty-rect repaint on by default since ADR 625)
plus this lane's harness change. Same fixture and method as the two A/B runs above: 1080p at `fps=30`,
7 seats online, 60 s windows, one in-page probe for draws and gaps, `/proc` CPU per process tree. Arms
in run order. `x11-cli` is the real `musterd broadcast --capture x11`, and `x11-adhoc` is increment 1's
hand-built arm, kept to check the mode is the arm that was measured. `floor` is whether the CLI's
12/s draw floor reported. Falsify: a re-run on the same build and box size puts `x11-cli` at 30 draws/s
or more, or under 23.

| arm | draws/s | gap p50 ms | gap p95 ms | chrome % | ffmpeg % | xvfb % | cli % | pipeline % | box idle % | floor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| screencast | 20.3 | 47.0 | 74.8 | 223.6 | 71.8 | — | 8.4 | 303.8 | 18.8 | silent |
| x11-cli#1 | 26.3 | 35.5 | 55.7 | 163.1 | 71.7 | 3.9 | 0.2 | 238.9 | 35.0 | silent |
| x11-adhoc | 26.3 | 35.8 | 53.5 | 167.8 | 70.6 | 4.3 | — | 242.7 | 34.2 | — |
| x11-adhoc `&dirty=0` | 19.4 | 49.3 | 67.1 | 156.1 | 71.2 | 4.7 | — | 232.0 | 36.5 | — |
| x11-cli#2 | 26.1 | 35.7 | 56.8 | 164.0 | 71.3 | 4.2 | 0.1 | 239.6 | 34.5 | silent |

Against the spec's bar:

| Measure | Pass | x11-cli (both runs) | Verdict |
| --- | --- | --- | --- |
| Draws/s over 60 s | ≥ 30 | 26.1–26.3 | **fails** |
| Gap p95 | < 40 ms | 55.7–56.8 ms | **fails** |
| Encoder queue growth | flat | no queue (no pipe under x11) | passes |
| Draw floor (12/s) | silent | silent | passes |
| Box CPU | some idle | ~35 % idle | passes |

Readings:

- **The bar is not met.** The best configuration draws ~26/s with a ~56 ms p95. That is the best the
  stream has measured (screencast was 13.7 on 2026-10-13), and it is still four draws short, with a tail
  half again over the 40 ms line.
- **The CLI mode is the arm that was measured.** `x11-cli` and `x11-adhoc` agree within 4 points of
  pipeline CPU and 0.2 draws/s, inside the wiki's 30-point falsifier.
- **Dirty-rect repaint is real on the box:** 19.4 → 26.3 draws/s (+36 %), gap p95 67 → 54 ms, against
  ADR 625's falsifier of "within 10 %". It costs ~12 points of Chrome CPU, which is the measure pass.
- **x11 still pays for itself:** against screencast on the same build it is +6 draws/s, −19 ms p95 and
  65 points of pipeline CPU freed, and the box sits a third idle.
- **The wall is one thread again.** A third of the box is idle while draws stop at ~26/s. Per the spec,
  the default stays screencast (no flip ADR) and lever 3 (drawing in an `OffscreenCanvas` worker) is
  opened as its own brainstorm. The live-stream half of this increment would only have confirmed a
  pass, so it is not run.

Follows-up: 01M55MAQ9MSK5JP45XK3V3GM6Z

## x11 at 24 fps, the sub-bar rung (Fly `performance-4x`, sjc, 2026-10-17)

Lane `01M55N47KJ`. Same build, fixture and method as the run above, at `--fps 24`
(`CAPTURE_AB_FPS=24`). Pre-registered before the run: ≥ 23 draws/s, gap p95 < 50 ms, draw floor
silent, box idle > 0. Falsify: a re-run on the same build and box size puts x11's gap p95 under 50 ms
at 24 fps.

| arm | draws/s | gap p50 ms | gap p95 ms | chrome % | ffmpeg % | xvfb % | cli % | pipeline % | box idle % | floor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| screencast | 19.5 | 49.1 | 80.1 | 226.9 | 61.6 | — | 8.0 | 296.5 | 20.4 | silent |
| x11-cli#1 | 23.4 | 36.8 | 73.3 | 149.3 | 55.9 | 3.2 | 0.1 | 208.5 | 42.4 | silent |
| x11-cli#2 | 23.4 | 37.7 | 74.0 | 153.4 | 57.0 | 3.4 | 0.2 | 214.0 | 41.0 | silent |
| x11-cli#3 | 23.3 | 37.6 | 73.3 | 151.2 | 56.8 | 3.4 | 0.1 | 211.5 | 41.8 | silent |

Readings:

- **The rung fails its own pre-registered bar** on the tail. Draws (23.3–23.4), floor and idle pass;
  the gap p95 (73–74 ms) does not.
- **The tail is worse at 24 than at 30** (56 ms above). That is unmeasured as to cause. _(Corrected
  2026-10-17: the cadence reading that follows is wrong. 20 fps divides the tick evenly and has the
  worst tail, in the next section.)_ The likely one was cadence: the page draws on rAF ticks of 16.7 ms, and 41.7 ms is not a whole number of them, so gaps
  alternate 33/50 ms and a missed draw lands at 67+. 30 (two ticks) and 20 (three) divide evenly.
- x11 is still the better pipeline at this rung: +3.9 draws/s and ~85 points of pipeline CPU freed
  against screencast.

## x11 at 20 against 30, interleaved (Fly `performance-4x`, sjc, 2026-10-17)

Lane `01M55N47KJ`, run after the 24 fps rung failed. Same build and method; arms
`x11-cli#1@20, #2@30, #3@20, #4@30` on one box (`CAPTURE_AB_ARMS`, per-arm fps). Pre-registered for
20 by the 24 rung's rule (95 % of the rate, p95 under 1.2× the interval): ≥ 19 draws/s, gap p95
< 60 ms, floor silent, idle > 0. Falsify: a re-run on the same build and box size puts the 20 fps p95
under 60 ms.

| arm | draws/s | gap p50 ms | gap p95 ms | chrome % | ffmpeg % | xvfb % | cli % | pipeline % | box idle % | floor |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| x11-cli#1@20 | 19.7 | 48.6 | 84.0 | 142.9 | 50.0 | 3.2 | 0.2 | 196.3 | 45.1 | silent |
| x11-cli#2@30 | 24.4 | 38.3 | 58.7 | 163.4 | 71.8 | 4.8 | 0.1 | 240.1 | 34.4 | silent |
| x11-cli#3@20 | 19.7 | 51.5 | 80.9 | 139.4 | 49.6 | 3.5 | 0.2 | 192.7 | 45.9 | silent |
| x11-cli#4@30 | 25.3 | 37.0 | 57.3 | 164.7 | 70.3 | 4.5 | 0.1 | 239.6 | 34.5 | silent |

Readings:

- **20 fails its tail bar too** (81–84 ms against < 60), so the cadence explanation in the 24 fps
  section above is wrong: 20 is three whole rAF ticks and has the worst tail of the three rungs.
- **The tail is about 1.7× the frame interval at every rung** (20: ~1.65×, 24: ~1.75×, 30: ~1.73×).
  A slower rate does not make the motion steadier; it makes each held frame longer.
- **30 is the best rung on every reading that matters to a viewer:** the most distinct frames
  (24.4–25.3/s), the shortest p95 hold (57–59 ms), and still a third of the box idle. 30's draws here
  sit 1–2/s under the 26.1–26.3 of the earlier run on the same build, which is inside the box-to-box
  variance this file already records.

## Live trial: x11 at 30 on the real room (Fly `performance-4x`, sjc, 2026-10-17)

Lane `01M55PYW9D`, ADR 642 Decision 4. Image `71f1759`, `--resolution 1080p --capture x11 --fps 30
--encoder libx264 --audio`, the live revive room, 20:12–21:27 UTC (75 min). These readings come from
ffmpeg's `-stats` samples (one per 10 s) in `fly logs`, not the bench harness, so the stream has no
draws/s or gap p95 row. Falsify: a second hour-long run on the same image where any sample reads
`speed=` under 1.00x or the draw floor fires.

| reading | value |
| --- | --- |
| samples | 450 |
| `fps=` | 30 in every sample |
| `speed=` | 1.00–1.04x, none under 1.00 |
| bitrate | 3899–4037 kbit/s (cap 4500k) |
| dropped frames | 48 in total, all in the first 10 s |
| draw floor, relaunch, frozen-page lines | none |
| audio | sink up, stereo input opened; not listened to |

Readings:

- **The encoder keeps up on the real room.** 30 fps at 1.00x for 75 minutes, with headroom under the
  bitrate cap. Decision 4 expected 30 to bind at 4500k. It did not, by about 460 kbit/s.
- **The bench fixture does not under-represent the room** on the one reading the live run has (the
  draw floor). The spec's third falsifier did not fire.

## Hypotheses already measured and rejected

Recorded so nobody re-chases them. Three died before this harness existed, two of them after being
half-believed.

| Hypothesis                       | Verdict                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Lower the JPEG quality**       | **Dead.** 177 KB → 84 KB, visually identical, no improvement — arguably worse. Decode cost is set by **pixel count, not file size**: 177 KB vs 67 KB moved ffmpeg only 175 → 182 fps.                                                                                                                                                                                                                                              |
| **ffmpeg is the bottleneck**     | **Dead.** Fed from a file it sustains ~175 fps, ~6× what the pipeline needs.                                                                                                                                                                                                                                                                                                                                                       |
| **Deduplicate unchanged frames** | **Dead on its premise, not its mechanism.** The mechanism works (3 JPEGs → 91 frames at exactly 30 fps CFR; 50 frames over 10.24 s → 301 frames / 10.033 s, which would even fix #367 drift). But broadcast disables the ambient FPS cap so every rAF tick draws, and the screencast captures the _page_, where the CSS overlay animates continuously. **~0% of frames are duplicates during a real stream.** No code was written. |

## Optimization log

| Date | Change | Result |
| ---- | ------ | ------ |
| 2026-07-31 | Cap broadcast draw rate to capture fps | Code: `ambientFrameBudgetMs` returns `1000/fps`; `shouldCoalesceDraw` applies under broadcast even during walks/cues (closes the known gap). CLI threads `?fps=` via `broadcastUrl`. **Re-measure on Fly `performance-4x` 720p25 before/after** — queue growth + delivered fps + chrome %CPU. Eye-check walking members for #368 judder. |

## Deliberately not done

- **Reducing what the office animates.** The dust motes, string lights, fan blades, nook steam,
  fireflies, breathing and monitor aurora are the brief — magical, warm, alive. They are not a perf
  budget line item.
- **Trusting `speed=`.** See above.
- **Single-run comparisons.** Interleaved A/B under matched load is the standard; it is what caught
  the JPEG-quality hypothesis.

## Known gap in the plan's candidate #1 — closed 2026-07-31

The budget alone only fired when `ambientOnly`. `shouldCoalesceDraw(broadcast, ambientOnly)` now
returns true whenever `broadcast`, so walks/cues also coalesce to the capture fps. Content rate
matches encode rate → no #368 judder from under-sampling; compositor stops painting frames the
encoder never sees.
