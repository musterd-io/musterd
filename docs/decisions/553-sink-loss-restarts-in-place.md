# 553 — A lost RTMP session restarts the broadcast in its machine, not the machine

- Status: accepted
- Date: 2026-10-09
- Deciders: nick ("We can't let the stream go offline anymore after we start it", 2026-10-08; chose the
  in-machine restart over a replaceable ffmpeg, 2026-10-09)
- Lane: `01M4F32MMP63ZF9AVNHWWF3N6A`, inc 4 of the stream-never-offline arc (inc 1: ADR 548, inc 2: ADR 551,
  inc 3: `01M4F2GZPRJ8SS18RZ81P51RAT`, which measured this)
- Builds on: ADR 551 (decision 3, "the sink half is unchanged", is what this changes), ADR 293 (the stream
  supervisor), `docs/wiki/broadcast-stream.md`

## Context

ADR 551 made Chrome replaceable and left the sink half alone: ffmpeg and its RTMP session still end the
stream when they die. Inc 3 measured what that costs on the hosted box (2026-10-09). A 5 s packet drop on
port 443 is ridden out by TCP and changes nothing. A reset connection, which is what Twitch dropping the
session looks like, is not:

| time (Z) | event |
| -------- | ----- |
| 01:03:09 | ffmpeg: `Connection reset by peer` |
| 01:03:11 | the broadcast returns 1; `entrypoint.sh` exits (it reruns only on 75); the machine ends |
| 01:03:54 | `stream ensure` (a 60 s LaunchAgent on the laptop) sees the machine gone and starts a new one |
| 01:04:45 | `◉ live` on a new machine and a new tailnet node |

96 s from the reset to live, before Twitch's own recovery. A daemon outage of 90 s did not touch the stream.

## Problem

A dead sink is a failure the stream cannot absorb, but the machine did not need to die with it. The whole
96 s is spent replacing things that were healthy: the Fly machine, the tailnet node, the audio sink and a
warmed Chromium.

## Decision

1. **ffmpeg ending after the stream was live, when nobody asked it to stop, exits `RESTART_EXIT_CODE` (75)
   under a supervisor.** `entrypoint.sh` already reruns the broadcast on 75, so the process restarts in the
   same machine. `sinkLossExitCode` makes the call and borrows `socketLossExitCode`'s judgement whole.
2. **The floors stay.** A run shorter than `RESTARTABLE_AFTER_MS` (60 s) ends instead, so a rejected key or
   a broken config cannot loop on a machine that bills by the hour. An unsupervised run (a laptop) ends. A
   stop that was asked for (a signal) is not a sink loss. A clean ffmpeg exit (`--duration`) stays 0.
3. **ffmpeg is not made replaceable in the running process.** That means rebinding the frame pump, the
   stderr scrubber, the exit promise, the perf recorder and every stop path, which are all tied to one
   ffmpeg. It would save a few seconds over this and costs much more risk. Revisit only if a measured
   restart gap turns out to matter.

## Consequences

A sink loss costs a process restart instead of a machine replacement. Expected: the `broadcast` start to
`◉ live` took 3 s on the box (01:04:42 to 01:04:45, Chrome already warm), so the gap should be seconds
plus the entrypoint's pause. It is not measured yet; see the experiment below. The machine, its tailnet
node and `ensure` are no longer involved.

Chrome restarts too, and the picture re-seeds. ADR 551's still frame during a Chrome relaunch does not
apply here: the RTMP session is new, so viewers see Twitch's reconnect, not a held picture.

A sink that drops every minute or two loops: each run clears the 60 s floor, so each one restarts. Nothing
caps it except `ensure` and a human, as with a lost Chrome socket today. A cap on restarts per window,
like ADR 551's `RELAUNCH_MAX`, would close that.

Follows-up: deferred — a restart cap, once a sink is seen restarting more than 3 times in 5 minutes (2026-10-09).

2026-10-09: the first measurement on the box showed the 60 s floor (decision 2) ending the machine on a
retry that Twitch closed 1 s after `◉ live`. ADR 555 exempts a supervised retry from that floor, with a cap.

ADR 551 decision 3 is changed by this ADR: the sink half still ends the stream, but under a supervisor
that now means a restart in the machine (decision 1 here).

## Observability & Evaluation

**Traces.** `✗ ffmpeg ended (code N) — the sink dropped. Asking the supervisor for a relaunch.`, then the
entrypoint's `▸ relaunching the stream (ran Ns)`, then a second `◉ live` on the same machine in
`fly logs`.

**Eval.** Dataset: the hosted box, one reset per run. Baseline (before, 2026-10-09): 3 s `tcp-reset` ->
machine replaced, 96 s to live. Pending: the same test on the image built from this change.

**Experiment.** On the hosted box, `iptables -I OUTPUT -p tcp --dport 443 -j REJECT --reject-with tcp-reset`
for 3 s while the stream is live. The machine id and the tailnet node must be unchanged, `fly logs` must
show the `Asking the supervisor` line and a second `◉ live`, and the time from the reset to the second
`◉ live` must be well under the 96 s baseline. A new machine, or a gap near 96 s, falsifies this ADR.
