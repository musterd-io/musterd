# 548 — A stream never drops its ingest to stay current

- Status: accepted
- Date: 2026-10-08
- Deciders: nick ("We can't let the stream go offline anymore after we start it", 2026-10-08)
- Lane: `01M4EC5X8M24MWKG7MW1XKGX8P`, inc 1 (inc 2: Chrome loss/freeze relaunches Chrome, not the
  stream; inc 3: measure what is left)
- Supersedes: ADR 159 §4 (a long-lived stream restarts itself when the daemon is rebuilt)
- Builds on: ADR 292 (an open page reloads itself onto the served bundle), ADR 152 (the daemon
  refreshes itself on every merge), ADR 157 (broadcast), ADR 293 (the stream supervisor)

## Context

ADR 159 §4 made a live stream poll the daemon's build and, when it changed, tear the stream down and
start again. It rejected a page reload as "half a fix wearing the costume of a whole one": a reload
refreshes the web bundle, but this process's capture pipeline stays stale. That reasoning had one
premise — that the process's code and the daemon's checkout move together.

On 2026-10-08 nick watched the hosted stream go "offline" on Twitch and then come back, and called it
terrible viewer experience. The box log shows why:

| time (Z) | line |
| -------- | ---- |
| 17:54:40 | `daemon rebuilt (a5c413a → 95782eb) — restarting the stream on the new code` |
| 17:54:42 | ffmpeg ends; `▸ relaunching the stream (ran 2105s)` |
| 17:54:45 | `◉ live 95782eb` |
| 18:15:46 | `daemon rebuilt (95782eb → 8203375) — restarting the stream on the new code` |
| 18:15:48 | ffmpeg ends; `▸ relaunching the stream (ran 1266s)` |
| 18:15:52 | `◉ live 8203375` |

Each restart closes the RTMP connection to Twitch for 3–4 seconds, and Twitch marks the channel
offline when the ingest drops. The ADR 152 auto-refresher bounces the daemon for every merge to
`main`, so the stream dropped about every 20 minutes during a working day. I have not measured how
long Twitch itself shows "offline" after each drop.

## Problem

The premise of ADR 159 §4 does not hold, in either half:

1. **The web bundle needs no restart.** ADR 292 landed after ADR 159. The broadcast page polls
   `/build.json` and reloads itself once onto the served build. ffmpeg and the RTMP session are
   untouched, so viewers see a still frame for a moment at most.
2. **The capture code does not move with the daemon.** On the hosted box the node process runs from
   `/app/packages/cli/dist`, baked into the image by `COPY . .`. A restart reran the same image. The
   only thing it refreshed was the web bundle, which is item 1. On a laptop the dist can be rebuilt
   under the stream, but capture-pipeline changes are rare against web changes, and a deliberate
   restart picks them up.

So the restart bought nothing the stream needed, and it cost the one thing a stream exists to do.

## Decision

1. **A daemon rebuild does not restart a stream.** The build poll, `daemonRebuilt`, and the
   re-exec/exit-75 path behind it are removed. The stream keeps running on the code it started with.
2. **The web bundle stays current through ADR 292**, as it already did.
3. **Capture-pipeline currency is a deliberate act**: `musterd stream build` then a restart, as
   `docs/guides/hosted-broadcast.md` already says for the hosted box.
4. **Exit 75 remains, for failures only** — a lost Chrome socket and a frozen picture. Those still
   restart the whole stream today; inc 2 of the lane narrows them.

## Consequences

A merge to `main` no longer drops the Twitch ingest. The hosted stream's uptime stops being tied to
the merge rate.

The cost is that a stream's capture code can fall behind the checkout. That was always true on the
hosted box; it is now true on a laptop too. `--status` still reports the daemon build the stream
started against, so the age is visible.

Failure restarts (Chrome socket loss, frozen picture) still drop the ingest. They are rarer than
merges but not rare enough to call the problem closed, which is why this is inc 1.

This does not change the stream that is on air now. It runs the Sep 30 image, so the fix reaches it
only after `musterd stream build` and a restart, which is one more brief drop.

## Observability & Evaluation

**Traces.** The box log no longer prints `daemon rebuilt … restarting the stream` or `▸ relaunching
the stream` after a merge. A relaunch line now means a failure, and the line above it names which.

**Eval.** Dataset: the hosted box's log, `fly logs -a musterd-broadcast`. Baseline: two ingest drops
in 40 minutes on 2026-10-08 (table above), one per merge. Target: zero drops across a rebuild.

**Experiment.** With a hosted stream live on the new image, merge any commit to `main`, wait past
the auto-refresher's tick, then read the log. ffmpeg's `frame=` count must keep climbing with no
`relaunching` line, and `musterd stream status` must show the same machine throughout. A relaunch
inside a rebuild window falsifies this ADR.

The removed behaviour was covered by `daemonRebuilt` unit tests, which are removed with it. The path
that replaces it is no code at all, so the proof is the live check above, not a unit test.
