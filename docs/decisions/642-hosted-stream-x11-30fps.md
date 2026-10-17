# 642 — The hosted stream records the X display at 30 fps

- Status: accepted
- Date: 2026-10-17
- Lane: `01M55N47KJ`. Spec: [`2026-10-13-broadcast-smooth-capture-design.md`](../superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md), increment 4's flip. Decided by nick in chat, 2026-10-17.

## Context

The hosted stream runs 1080p at 15 fps through the CDP screencast (`scripts/broadcast/entrypoint.sh`,
2026-09-30). nick called it choppy and set the bar at a steady 30 fps on the CPU-only Fly
`performance-4x`: ≥ 30 draws/s and a gap p95 under 40 ms (the spec's bar).

Two levers have since landed. `musterd broadcast --capture x11` (#2784) records an Xvfb display with
`x11grab` instead of JPEG screencast frames. Dirty-rect repaint (ADR 625) is on for `/broadcast` by
default. On the bench (`docs/perf/broadcast-baseline.md`, four sections dated 2026-10-17):

| configuration | draws/s | gap p95 | box idle |
| --- | --- | --- | --- |
| screencast at 30 | 20.3 | 75 ms | 19 % |
| x11 at 20 | 19.7 | 81–84 ms | 45 % |
| x11 at 24 | 23.3–23.4 | 73–74 ms | 42 % |
| x11 at 30 | 24.4–26.3 | 56–59 ms | 34–35 % |

## Problem

No configuration meets the bar. The spec ties the flip of the default to a pass, and lever 3 (drawing
in an `OffscreenCanvas` worker, lane `01M55MAQ9M`) is its own brainstorm, weeks away at best. Waiting
keeps the stream at 15 fps the whole time. Each lower rung was given a bar scaled to its rate (draws ≥
95 % of it, p95 under 1.2× the interval) before its run, and both failed on the tail: the p95 is about
1.7× the frame interval at 20, 24 and 30 alike. A lower rate only holds each frame longer.

## Decision

1. **The hosted stream captures with `--capture x11` at `--fps 30`**, 1080p, libx264 `veryfast`,
   4500k, `--audio`, as before in every other flag (`scripts/broadcast/entrypoint.sh`).
2. **It is a step, not the bar.** The spec's 30 fps bar stands, and lever 3 (`01M55MAQ9M`) still goes
   after it. This ADR does not mark the smooth-capture goal met.
3. **The CLI default stays `screencast`.** Only the hosted entrypoint changes. x11 needs Linux, and a
   laptop capture keeps today's behaviour.
4. **It is kept only after a live trial.** The bench room is synthetic, and x11 has not yet carried
   audio or run for hours. Broadcast is stopped (nick, 2026-10-17), so the trial starts when a human
   admin starts the stream. It keeps x11 at 30 if, over at least an hour, the draw floor stays
   silent, ffmpeg holds `speed=1.00x` with the bitrate under the cap, and audio is heard. Otherwise the
   stream reverts.
5. **Reverting needs no rebuild.** `BROADCAST_ARGS="--capture screencast --fps 15"` restores today's
   stream, because the CLI's last flag wins. The entrypoint change itself rides `musterd stream build`.

## Consequences

- About 25 distinct frames a second instead of at most 15, and a p95 hold of ~57 ms instead of at
  least 67 ms. Under x11, ffmpeg samples on its own clock, so about one frame in six is a repeat.
  Screencast's padded repeats were the 2026-09-17 complaint, but at 15 fps every repeat is a full
  67 ms hold.
- **Bitrate is unmeasured at 30.** The 4500k cap was set for 15 to 20 fps, and 1080p15 already used
  ~3334 kbit/s. At 30 the same cap spreads over twice the frames, so it is likely to bind, and a busy
  room could soften. The trial reads ffmpeg's `-stats` bitrate, and a raise is its own change.
- A Chrome relaunch shows Xvfb's black root for the seconds the new Chrome takes (screencast showed
  the last frame). The relaunch path is otherwise unchanged (ADR 551).
- Box CPU: x11 at 30 leaves about a third of the box idle against a fifth for today's screencast at
  30, so the encoder's queue watchdog has room.

- _(2026-10-17, lane `01M55PYW9D`)_ **Live trial: three of four checks passed, audio unconfirmed.**
  The trial ran 75 min (20:12–21:27 UTC) on image `71f1759` against the live revive room. The draw
  floor, relaunch and freeze lines never appeared. All 450 ffmpeg samples (one per 10 s) held
  `fps=30` and `speed=1.00–1.04x`. The bitrate ran 3899–4037 kbit/s, under the 4500k cap, and 48 frames
  dropped in total, all in the first 10 s. The audio sink came up and ffmpeg opened its stereo input,
  but nobody listened, so "audio heard" is unconfirmed (nick, 2026-10-17). The stream stays on x11
  at 30. Numbers: `docs/perf/broadcast-baseline.md`, "Live trial".

## Observability & Evaluation

- **Traces:** n/a. This changes the capture pipeline, not an agent-facing path.
- **Eval:** the live trial's three readings in Decision 4: the draw floor (`DRAW_FLOOR_FPS`, already
  armed on every run), ffmpeg's `-stats` line every 10 s (`speed=`, bitrate), and a human listening for
  the sink. The x11 freeze watchdog (`drawAdvanced`) reports a frozen page in the run log.
- **Experiment:** the bench rows above are the before. The trial is the after, on the real room.
  Falsifier: if the live draw floor fires at x11 30, the bench fixture under-represents the real room
  (the spec's third falsifier), and the stream reverts to screencast at 15 until it is re-measured on
  the live team.
