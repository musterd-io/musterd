# 551 — A lost or frozen Chrome relaunches Chrome alone, never the stream

- Status: accepted
- Date: 2026-10-08
- Deciders: nick ("We can't let the stream go offline anymore after we start it", 2026-10-08)
- Lane: `01M4EHDK1QRNRNNRAJB2YG8G72`, inc 2 of 3 (inc 1: ADR 548, a daemon rebuild no longer restarts the
  stream; inc 3: measure what is left)
- Builds on: ADR 548, ADR 293 (the stream supervisor), ADR 159 §§1–3 (the stall watchdog and the stop
  path), the 2026-09-16 frame-arrival watchdog (`docs/wiki/broadcast-stream.md`)

## Context

A stream has two halves with different lifetimes. The **sink half** is ffmpeg and its RTMP session to
Twitch. The **source half** is headless Chrome, its scratch directory and its DevTools socket. The
frame pump sits between them and re-emits the last frame on a wall clock, so ffmpeg never starves
while Chrome is slow or briefly silent.

Every Chrome failure ended the whole stream anyway:

- **A frozen picture.** The frame-arrival watchdog found no screencast frame for 5 s and called
  `forceStop(socketLossExitCode(…))`, killing ffmpeg. On the hosted box that exits 75 and
  `entrypoint.sh` runs the stream again.
- **A lost DevTools socket.** By the code's reading it surfaces as the same freeze a few seconds later,
  because the in-flight calls that fail on it are all caught quietly.
- **Chrome exiting.** It called `gracefulStop`, ffmpeg finalized, and the process returned 0. On the
  box that ends the machine, and ADR 293's 60 s LaunchAgent has to start a new one. It is the same
  class as the 2026-08-18 Chrome death.

Each of those drops the Twitch ingest, which is the "offline" nick saw. Inc 1 removed the most
frequent trigger (a merge); these are the rest of the ones the stream itself causes.

## Problem

Nothing about a Chrome failure damages ffmpeg or the RTMP session. The restart is a response to the
source dying, applied to the half that is still healthy.

## Decision

1. **A Chrome failure replaces Chrome and leaves the stream alone.** On a frozen picture or an
   unexpected Chrome exit the stream retires the capture (kills Chrome's process group, closes its
   socket, removes its scratch directory), starts a new one with the same launch path as the first, and re-arms
   the watchdog. The pump keeps re-sending the last frame throughout, so ffmpeg and the ingest never
   notice and viewers see a still picture for the relaunch instead of an offline channel.
2. **The relaunch is bounded.** `decideRelaunch` allows 3 relaunches in 5 minutes. A fourth, or a
   relaunch that does not come back (Chrome never ready), falls back to the whole-stream path:
   `socketLossExitCode`'s verdict, exit 75 under a supervisor once the run has proven itself, an
   ended stream otherwise. A Chrome that keeps dying is a broken run, and relaunching it forever
   would bill a machine that shows nothing.
3. **The sink half is unchanged.** ffmpeg exiting, a stalled encoder, a signal, `--duration` and a
   failed first launch still end the stream as before. Only the source half is replaceable.
4. **The first launch and every relaunch share one path**, `launchCapture`. The perf recorder (an
   opt-in dev tool that truncates its output file) runs for the first capture only.

## Consequences

A Chrome failure no longer drops the Twitch ingest. What viewers see instead is a still frame for as
long as the new Chrome takes to come up. Measured locally on a loaded laptop: 7.9 s for a killed
Chrome, 13.9–26.1 s across the later relaunches. The box is faster at warm Chrome starts, but I
have not measured it there.

The relaunch also applies to a laptop run, which used to end the stream on any Chrome failure.

The frozen frame is not an announcement. Nothing tells viewers the picture is stale. A "reconnecting"
slate is the obvious follow-up and is not built here.

Failures that sit on the sink side still end the stream: a lost network path to Twitch, Twitch
refusing the key, the laptop sleeping under the daemon. Measuring how often those occur is inc 3.

*Note, 2026-10-09:* the experiment below ran on the box: `kill -9` of Chrome's process group left the
machine and ffmpeg (pid 962) unchanged, Chrome came back as a new pid, and `fly logs` carried `capture
back after 3.5s`. Inc 3 then measured the sink side: a 5 s packet drop is ridden out, a reset connection
ended the machine (96 s to live), and a 90 s daemon outage did not touch the stream. Decision 3's "the
sink half is unchanged" is changed by ADR 553: a sink that dies under a live run restarts the broadcast
inside the machine.

## Observability & Evaluation

**Traces.** A relaunch writes `✗ <reason> — relaunching Chrome; the stream stays up on its last
frame.` and then `capture back after N.Ns`. The give-up writes the old `Ending the stream.` /
`Asking the supervisor for a relaunch.` line with the reason. `fly logs` shows all of them.

**Eval.** Dataset: real local captures to a file (`--out`, 15 fps, the daemon on `:4849`), the same
code path the hosted box runs. Baseline: before this change a Chrome kill ended the process. Result
(2026-10-08, one run each):

| fault | before | after |
| ----- | ------ | ----- |
| `kill -9` Chrome's process group mid-run | stream ends | `capture back after 7.9 s`, ffmpeg pid unchanged, output file 75.0 s / 1125 frames (exactly 15 fps × 75 s), ended cleanly |
| `SIGSTOP` Chrome (frozen picture) | watchdog ends the stream | watchdog fires at 5.0 s, `capture back after 13.9 s` |
| two more kills, then a fourth | stream ends at the first | relaunches 2 and 3 come back (16.2 s, 26.1 s); the fourth gives up: `failed 3 times in 5 minutes … Ending the stream.` |
| leftovers after each run | — | no stray processes, no scratch directories |

**Experiment.** On the hosted box, `fly machine exec` a `kill -9` of Chrome's process group while
the stream is live. ffmpeg's pid and the machine must be unchanged, the box log must show
`capture back`, and Twitch must keep reporting LIVE. A machine replacement or a second `◉ live`
line falsifies this ADR. Run on the box 2026-10-09 (see the note above); it held.
