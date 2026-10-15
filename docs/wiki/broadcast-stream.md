# The Twitch broadcast — topology and cost

The stream rents one Fly machine per stream (its lifetime IS the stream's) reaching the loopback daemon over Tailscale; the whole cost is compute, not egress — and two plausible cost claims were measured dead.

## Topology (2026-07-29 review; ADR 157 is the contract)

`musterd stream start` rents one Fly machine (app `musterd-broadcast`, performance-4x, auto-destroy) that reaches the laptop's loopback-bound daemon via Tailscale (`MUSTERD_AIR_ADDR` is a tailnet name; the ADR 040 allow-list accepts that Host). Stop with `musterd stream stop`, never by killing the machine. Nothing stream-related runs locally unless you run `musterd broadcast` yourself — except the ADR 293 supervisor below.

## Crash vs deliberate stop (2026-08-19, ADR 293; falsify: induce a crash with a raw `fly machine stop` and watch `stream ensure` heal it) <!-- claim: other -->

The verbs record intent in `~/.musterd/stream/state.json`: `start` says live (before launching), `stop` says stopped with **who and why** (`--reason`, shown by `stream status`) — so a machine gone while the file says live is a crash by definition. `musterd service install --stream` installs a 60s LaunchAgent running `stream ensure`: crash → relaunch (≤3 per 30min, then it stands down and asks the team as the `streamwatch` service seat until a human `stream start` re-arms). Consequences to know: killing the machine any way other than `stream stop` now gets healed within ~60s, and `stream start --once` is the opt-out for deliberately unsupervised (e.g. `--duration`) runs. The 2026-08-18 Chrome death ("Chrome DevTools socket closed", dead until a human noticed) is the incident this closes; ADR 292 keeps the restarted page's bundle current from there.

## A Chrome failure ended the whole stream though only the picture source had died (2026-10-08; falsify: `fly machine exec` a `kill -9` of Chrome's process group on a live hosted stream — a changed ffmpeg pid, a new machine, or a second `◉ live` line falsifies this) <!-- claim: defect -->

A frozen picture (the frame-arrival watchdog), a Chrome exit and a lost DevTools socket all ended the
stream: `forceStop` killed ffmpeg, or a graceful stop returned 0, and on the box the supervisor ran
the whole thing again. ffmpeg and the RTMP session were healthy in every case. The frame pump already
re-emits the last frame on a wall clock, so they could keep running while a new Chrome started.

ADR 551 replaces Chrome alone (`relaunchCapture`): the capture is retired, a new one launched by the
same `launchCapture`, the watchdog re-armed. Capped at 3 relaunches in 5 minutes, then the old
whole-stream path. Verified on real local captures to a file: a killed Chrome came back in 7.9 s with
ffmpeg's pid unchanged and a 75.0 s / 1125-frame output; a SIGSTOPped one was caught at 5.0 s and came
back in 13.9 s; the fourth failure gave up. Viewers see a still frame for the relaunch (8–26 s on a
loaded laptop), not an offline channel.

**Verified on the hosted box (2026-10-09).** `kill -9` of Chrome's process group (pgid 963) on the
live machine: the machine and `ffmpeg` (pid 962, 9 min up) did not change, Chrome came back as pid
1349, and `fly logs` carried `capture back after 3.5s`. Whether Twitch showed the channel as offline
in that window was not watched. Sink-side failures are the next section.

## What still takes the stream offline is downstream of ffmpeg, and one transient RTMP error costs about two minutes (2026-10-09; falsify: `fly machine exec` an iptables DROP on the box's route to `rtmps://live.twitch.tv` for 5 s on a live stream and read `fly logs` — ffmpeg still alive afterwards, or no `crash detected` within ~2 min, falsifies this) <!-- claim: defect -->

**Falsified for a 5 s packet drop (2026-10-09).** Written from the code before it was run. The 5 s `DROP`
was then run on the box: ffmpeg (pid 962), node (pid 955) and the machine were untouched, because TCP rode
the blip out. The claim survives only for a connection that dies, which is measured in the next section.

## A reset connection from Twitch's side takes the whole machine down, and the stream is back in about 96 s; a 5 s packet drop does not (2026-10-09; falsify: `fly machine exec` an `iptables` REJECT with `tcp-reset` on outbound 443 for 3 s on a live hosted stream — ffmpeg still running afterwards, or no `crash detected` and relaunch, falsifies this) <!-- claim: defect -->

**Measured (hosted box, 2026-10-09Z).** A 3 s `REJECT --reject-with tcp-reset` on outbound 443:

| time (Z) | event |
| --- | --- |
| 01:03:09 | `[tls] IO error: Connection reset by peer` from ffmpeg |
| 01:03:11 | `Main child exited normally with code: 1`; the machine reboots and is not restarted (policy `no`) |
| 01:03:54 | `stream ensure` records the crash and starts a new machine |
| 01:04:19 | the new machine's API socket is up |
| 01:04:45 | `◉ live` on machine `781e029ce950d8` |

So 96 s from the reset to `◉ live`, on a new Fly machine and a new tailnet node. Twitch's own recovery
comes on top; it was not watched.

Why: after `◉ live`, `broadcast.ts` waits on one thing, `exitCode = await ffmpegExit`. ffmpeg exits on a
dead sink, the command returns 1, and `entrypoint.sh` only loops on 75, so it exits and the machine
goes with it. Nothing reconnects the RTMP session in place. The 96 s is the `ensure` tick (45 s here after the
machine died, up to 60 s) plus 51 s from detection to `◉ live` (25 s to launch the machine, 26 s for it to go live; the first launch today took 58 s from create to live).

What the history says about the laptop side (`~/.musterd/stream/ensure.log`, 31k lines, last
written 2026-10-06, no timestamps): 53 `crash detected`, 51 `live again`, and 24 `no such host` lines
for `api.machines.dev`: the laptop had no network while `ensure` tried to relaunch, so a relaunch
failed and waited for the next tick; two lines match a stand-down or give-up. So `ensure` already rides out a short laptop
outage, but it cannot relaunch while the laptop is offline, and the laptop is the only thing that
runs it.

What the laptop does now: `pmset -g log` shows `Maintenance Sleep` / `DarkWake` cycles every ~15 min
from 13:56 to 16:56 PDT on 2026-10-08, then `Clamshell Sleep` at 17:13 and a wake at 17:20. The
laptop was on battery (32 %, discharging) when I checked, after the stream restart. `caffeinate -i` assertions from agent sessions
stop idle sleep but not a closed lid, so a lid close with the stream live is a real path. No stream
was live in those windows, so none of it is a measured outage.

**A daemon outage of 90 s does not take the stream down (2026-10-09; falsify: on a live hosted stream, `iptables -I OUTPUT -d <daemon tailnet ip> -j DROP` for 90 s, then read `ps` and `fly logs` — a changed ffmpeg pid, a new machine, or a `relaunching` / `capture back` line falsifies this)** <!-- claim: other -->

This stands in for the laptop sleeping: from the box the daemon (`100.100.246.14:4849`) simply goes
away. Dropped for 90 s on machine `781e029ce950d8` (01:09:15Z), the block confirmed with a probe
(`curl` to `/health` returned `000` while the rule was in, `200` after). node 959, ffmpeg 966 and
Chrome 967 kept their uptimes, the machine did not change, and `fly logs` carried no watchdog,
relaunch or ffmpeg error line. The page keeps drawing locally, so the frame watchdog (arrival-based)
never sees a gap. **Not seen:** what the picture showed (a live office, or a frozen one), and whether
the page's data reconnected cleanly afterwards; nobody was watching Twitch. And 90 s is shorter than
a real sleep: a closed lid is minutes to hours, and `ensure` cannot relaunch anything while the laptop
is down.

**Not measured, and why:**

- A daemon outage of minutes, and the picture during and after any outage. Needs someone watching
  Twitch, or a capture of the page.
- Twitch rejecting the key. Needs a deliberately wrong key on a live stream; the reset above is the
  closest stand-in and does not tell a rejected key from a dropped session.
- How long Twitch shows the channel offline for each of those. Needs a watcher on Twitch's side.

Inc 3 measured the reset case; the rest of the list above is still open. Inc 4 (ADR 553, lane
`01M4F32MMP63ZF9AVNHWWF3N6A`) changes the reset case: ffmpeg ending after `◉ live` now exits 75 under a
supervisor, so the broadcast restarts inside the machine instead of the machine ending.

### Twitch refuses a reconnect made seconds after a reset, so one in-machine retry is not enough (2026-10-09; falsify: repeat the 3 s `tcp-reset` on a live hosted stream on an image built from ADR 555 — a second `◉ live` followed by an ffmpeg `End of file` and an exit of the machine falsifies the retry, and a later `◉ live` on the same machine id that holds supports it) <!-- claim: defect -->

**Measured (hosted box, machine `80e450b6543428`, image `b8c90e58e30e` = inc 4):**

| time (Z) | event |
| --- | --- |
| 03:45:48 | `Connection reset by peer`; `ffmpeg ended (code 1) — the sink dropped. Asking the supervisor for a relaunch.` |
| 03:45:49 | `▸ relaunching the stream (ran 132s)` — same machine |
| 03:45:55 | `◉ live` — 7 s after the reset (the 96 s baseline was a new machine) |
| 03:45:56 | ffmpeg: `tls Error in the pull function … End of file` on `rtmps://live.twitch.tv` — Twitch closed the new session |
| 03:45:58 | `Main child exited normally with code: 1`; the machine ended, `ensure` replaced it |

The in-machine restart works. What ended the machine was the 60 s floor: the retry ran 7 s, below
`RESTARTABLE_AFTER_MS`, so `sinkLossExitCode` returned 1. The floor exists so a rejected key cannot loop;
here it fired on a retry of a stream that had been live for 132 s. The `iptables` rule came off at about
03:45:51, so Twitch refusing the connection is the likelier cause than the rule, but this run does not
separate the two. **How long Twitch refuses is not measured.**

ADR 555 treats a rerun after a restart as a retry: `entrypoint.sh` hands the stream a count of short runs
in a row (`MUSTERD_BROADCAST_SINK_RETRY`) and waits 10, 20, then 30 s between them; the stream asks for a
rerun until six short runs have failed, then ends the machine and `ensure` takes over as before.

**Measured on the box with ADR 555 (machine `894036c6431608`, image `917843deea30`, 2026-10-09Z):**

| time (Z) | event |
| --- | --- |
| 04:05:31 | 3 s `tcp-reset`; ffmpeg ends |
| 04:05:32 | relaunch (the run had lasted 66 s, so no extra wait) |
| 04:05:37 | `◉ live` |
| 04:05:39 | Twitch closes the new session (`End of file`); ffmpeg ends again |
| 04:05:42 | retry 2 (`ran 7s`; the loop waited out the 10 s floor) |
| 04:05:45 | `◉ live`, and it stayed up (checked to 04:11, no further error) |

14 s from the reset to a live that held, on the same machine, against 96 s on a new one. It took two
relaunches: Twitch refused the first reconnect about 2 s after accepting the TCP session and took the
second. One run, one reset: how long Twitch refuses a reconnect is still not known, and the cap of six is a guess.
Picture and Twitch-side offline time were not watched.

## A merge to `main` dropped the Twitch ingest, and the restart it ran bought nothing (2026-10-08; falsify: with a hosted stream live on the new image, merge any commit and read `fly logs -a musterd-broadcast` — a `relaunching the stream` line inside the rebuild window falsifies this) <!-- claim: defect -->

nick saw the channel go "offline" and come back. The box log had two matching events 21 minutes apart
(17:54Z and 18:15Z): `daemon rebuilt (…) — restarting the stream on the new code`, ffmpeg ending,
`◉ live` again 3–4 s later. ADR 159 §4 restarted a stream on every daemon rebuild, and the ADR 152
auto-refresher rebuilds the daemon for every merge, so the RTMP connection dropped about every 20
minutes on a working day.

The restart's stated reason was that a page reload leaves the capture pipeline stale. On the hosted
box that is empty: the node process runs from `/app/packages/cli/dist` baked into the image (`COPY . .`
in `hosted.Dockerfile`), so a restart reran the same code, and the only thing it refreshed was the web
bundle — which ADR 292's build-sync already reloads onto the served build with ffmpeg untouched.
Fixed by ADR 548: the build poll and its restart are gone.

**Not measured:** how long Twitch shows "offline" after a drop. The gap on the box was 3–4 s; what
viewers saw was longer, and the player does not always recover on its own. Failure restarts (Chrome
socket loss, frozen picture) still drop the ingest — lane `01M4EC5X8M`, inc 2.

## Two claims the evidence killed (measured 2026-07-29; falsify: read entrypoint.sh + re-measure bitrate)

1. ~~"The hosted stream runs 1080p30 and delivers 10 fps"~~ — wrong: `scripts/broadcast/entrypoint.sh` pins 720p25; the 1080p30 row in docs/perf/broadcast-baseline.md is the REJECTED arm. Read the entrypoint, not just the bench. ~~720p25 (2026-07-29)~~ SUPERSEDED 2026-09-15: the entrypoint now pins **1080p20**, measured at speed 0.998x on the same box (1080p15 sustains a clean 1.00x and is the fallback rung) — 1080p30 stays rejected, but 1080p was never the problem at a lower frame rate and nobody had checked. SUPERSEDED 2026-09-30: the entrypoint pins **1080p15**. 20 was never delivered: the office draws 9-11 frames/s on the box, so half of each 20 fps second was repeats (docs/perf/broadcast-baseline.md, dated note).
2. ~~"Lower the bitrate to halve egress"~~ — wrong: a 10 h stream is ~3 GB of egress, cents. The cost is compute, and at ~2.7 cores of pipeline performance-4x cannot step down to 2x. ~~"the flat-color iso scene encodes at ~780 kbit/s against a 4500k cap that never binds" (2026-07-29)~~ INVALIDATED 2026-09-15 (falsify: read ffmpeg's `-stats` summary off any capture): measured **~2900 kbit/s at 720p25**, **~3334 at 1080p15** and **~3517 at 1080p20**, against the same 4500k cap. The room has gained props, lighting, a night veil and more members since July; the scene is no longer "flat colour" in the sense that figure assumed. The conclusion above still holds — egress is still cents, compute is still the cost — but the cap is much nearer binding than recorded, and a bitrate decision made on the 780 figure would be made on a number that is four times off. <!-- claim: other -->

## The local VideoToolbox arm (measured 2026-07-29, 45 s probe — promising, UNPROVEN)

Hardware encode is essentially free (ffmpeg on `h264_videotoolbox`: 4.3–8.6 % of one core); the bottleneck is Chrome's render. Mid-run speed dipped to 0.57x before recovering — marginal, not comfortable. nick's decision 2026-07-29: leave the stream infra exactly as is; do not migrate to the laptop on the strength of a 45 s probe. A 10–15 min soak (guarded per [nicks-laptop](nicks-laptop.md)) remains queued.

## The supervisor used to duplicate a healthy start (2026-09-03; falsify: `fly machine list --json` during a boot, then run `stream ensure`) <!-- claim: defect -->

`startedMachines()` filters `state === 'started'`, and every "is a machine already there" decision
asked it: the ADR 293 crash predicate, `start`'s own double-launch guard, and `stop`. But Fly reports
`created`, then `starting`, for the whole boot — **29.0s** on the run that caught this, 26.5s of it
pulling the 593 MB image. Inside that window the running question returns a false empty, so the
supervisor (60s tick) read `liveCount 0` under `desired: live` as *"crash detected: machine gone"*
and launched a **second performance-4x machine on top of a perfectly healthy start**.

Observed: `287d675bd05d08` created 18:08:52; `e8262d2f5e92e8` reached `streaming (rtmps)` at
18:10:28, hit `rtmps://live.twitch.tv/... Input/output error` — Twitch refuses a second ingest on one
key — and died at 18:10:47. Both machines billed, and which one survived was a race. The irony is
that `startedMachines`' own doc comment already warned that "a false empty would let `start` boot a
second machine beside a live stream — two encoders on one Twitch key, and double billing"; the
warning was right and the predicate was the door it came through.

Fixed by asking the right question: `occupiedMachines()` counts `created`/`starting`/`started`/
`replacing` — a machine holding the slot, up or not — and the three deciding call sites use it. The
same bug made `stream stop` during a boot print "nothing live" and walk away from a machine that
then came up and billed unattended; that path is fixed with it. `status` deliberately still reports
`started`, because there "live" means *streaming* and a booting machine is not yet.

## "The digest differs" stopped being evidence of a deploy the day a second checkout existed (2026-09-17; falsify: back-date `scripts/broadcast/.image-digest` in the main checkout, start a stream from a worktree, and watch `stream ensure` call the vanish a crash rather than a deploy) <!-- claim: defect -->

`.image-digest` is **gitignored and per-checkout**, and streamwatch's LaunchAgent has
`WorkingDirectory` `/Users/nick/agents/packages/cli/dist` — so `findRepoRoot` always resolves the
**main** checkout, while a stream is routinely started from a worktree. Measured the day the stream
was started from `agents-miley`:

| | |
| --- | --- |
| `/Users/nick/agents` | `c084cf6f` — **Sep 3**, 14 days old |
| `/Users/nick/agents-miley` (started the stream) | `ffdc018f` — Sep 16 |
| `~/.musterd/stream/state.json` `image` | `ffdc018f` |

So `decideEnsure` saw `state.image !== recordedDigest` and took the 2026-08-21 deploy branch. Three
consequences, and the third is the one worth keeping: it would have relaunched the capture on
**14-day-old code** (no frame watchdog, no `coalesceStep`, no ack fix — every defect closed on this
page since Sep 3, back); it would have done so **uncharged to the flap budget**, because a deploy
deliberately does not spend one; and the log would have **asserted a deploy that never happened**.
That last is the same error as `entrypoint.sh` claiming a rebuild for every exit 75, one layer up —
*a cause the supervisor cannot know is one it must not assert.*

The 2026-08-21 predicate was not wrong when it was written; it was written when one checkout was the
only checkout, and a worktree silently removed its premise. **A heuristic whose premise is a fact
about the environment fails silently when the environment gains a case.**

Two changes, and they are deliberately separate:

1. **A digest that predates the run is not a deploy.** `decideEnsure` now takes `recordedDigestAt`
   (the file's mtime) and demotes the deploy reading when the digest was written before `state.at`,
   since a file older than the run is older than the image the run launched. Absent (legacy state,
   unit tests) the old reading stands: only positive evidence of age demotes it.
2. **A crash relaunches what the STREAM recorded, not what the checkout holds.** `ensure` launches
   `d.state.image`, and `launchPreconditions`' digest is now only the fallback for legacy state with
   no `image`. The deploy branch remains the one path that adopts a new digest, and it has now
   proven the digest postdates the run.

~~Belt and braces on purpose: even a misclassified deploy now launches the right image.~~
CORRECTED 2026-09-17 by sloane's cross-family review of #1538, which caught the sentence claiming in
both directions what it had only earned in one: a digest that is merely *stale* could no longer
hijack a relaunch, but a genuine rebuild in the **main** checkout during a **worktree**-started
stream postdated `state.at`, passed the age gate, and relaunched main's image for a stream that
never ran it — uncharged. The age gate answered the question it could ask, not the one that
mattered.

### The fix was to give the digest one home, at which point the age proxy dissolves (2026-09-17; falsify: `stream build` in one checkout, `stream ensure` from another, and read which digest it launches) <!-- claim: other -->

Both of the above are properties of *where the digest lived*, so the repair is a location, not a
sharper heuristic. The record now sits at `~/.musterd/stream/image.json`, beside `state.json`:
written by `stream build` wherever it runs, read by `start`, `ensure` and `doctor` without reference
to a checkout. `scripts/broadcast/.image-digest` is no longer written and is read only when no
machine record exists, so an existing laptop keeps working until its next build.

**The age gate is gone for the authoritative record, and that is the result rather than a
simplification.** `start` launches whatever the record said and stamps it into `state.image`, so a
record that now *differs* can only mean somebody rebuilt since — whichever checkout they ran it in,
whichever way the timestamps fall. One comparison, the same rule in both directions. The mtime gate
survives only on the legacy per-checkout path, where the asymmetry it was built for is still real.

`stream doctor` now says **whose** image it is reporting (`recorded for this machine` vs `from this
checkout only`). A doctor that prints a digest without saying who holds it is the same false green
one layer down — it read green in a worktree while the supervisor would have launched something
else.

**Mitigated on the live stream before the code landed** by copying the running digest into the main
checkout's `.image-digest` (old value kept at `.image-digest.bak-20260917`), so the stream running
that afternoon could not be healed backwards.

## ffmpeg's `fps=20 speed=1.00x` was padding — the page delivered 15 (2026-09-16; falsify: `MUSTERD_BROADCAST_PERF` on the live box, compare `deliveredFps` to `encodedFps`) <!-- claim: defect -->

nick saw a "tiny bit choppy" on member walks and act bubbles at 1080p20 while every throughput
number said healthy. The perf recorder on the live performance-4x (407 s) said why: Chrome
delivered **14.9 distinct frames/s** (min 12, p95 16) while the pump emitted **20.0**, so ~26 % of
encoded frames were the previous frame re-sent, unevenly spaced. `speed=` and `fps=` are the
encoder's view and do not carry this; the pump re-emits the latest frame on a wall clock by design.
The instrument that could — `deliveredFps` vs `encodedFps` in the JSONL — existed since July and had
not been run on the hosted box.

Cause: the office's broadcast draw coalescer skipped any rAF tick that arrived under the 50 ms
budget (`acc < budget → skip`). That is exact when rAF runs far faster than the budget (a 60 Hz
viewer), but on the box at 1080p the rAF itself ran **~19-20 Hz** — a period equal to the budget —
so every tick a hair early was dropped and the next drew at ~100 ms. `draws/s ≈ delivered/s ≈ 15`,
`ticks/s ≈ 19`. Fixed by `coalesceStep`: draw on the tick nearest the budget (`phase + raf/2 ≥
budget`) and carry the remainder, clamped to ±half a budget so a stall cannot bank catch-up draws.
The viewer's 20 fps ambient cap is unchanged (60 Hz still draws every third tick).

What this does **not** fix: the rAF running at ~20 Hz means the box's per-frame cost (paint +
composite + 1080p JPEG screencast) is ~50 ms with no headroom. Chrome sat at 220 % of a core with
canvas draw rate making no difference to that figure (14/s and 16/s buckets both 219 %), so the
cost is in the screencast/composite path, not the scene painting.

**After the fix (2026-09-16 03:45Z, same box, same recorder, 426 s):** delivered **26.9/s** (min 17,
p5 19, median 26), encoded 20.0, repeats **0.6 %** (53 of 8524). Acceptance (≥ 19) met. Two things
the after-run shows that the before-run could not: draws/s (median 18) is now *below* delivered/s,
so roughly a third of composited frames come from something other than the canvas loop — DOM
bubbles, CSS transitions — and Chrome rose to 253 % of a core because it now JPEG-encodes ~7
screencast frames/s that the 20 fps pump discards. `screencastEveryNthFrame(20)` is 1 because
`compositorHz` assumes 30 on Linux; the box composites nearer 27 here. That waste is the next cut
if Chrome's CPU ever needs to come down; it does not affect what the viewer sees.

## Half speed is not a gap, so the freeze watchdog cannot see it — the floor is under `draws`, not under arrivals (2026-09-17; falsify: run a capture on a box that holds 18 draws/s and read `drawFps` p5 out of the perf JSONL — a p5 under 12 on a box we call healthy means this floor is set too high) <!-- claim: defect -->

nick said the stream looked slower than the evening before. It was: the live capture drew **8.06 frames/s inside a 20 fps stream**, measured over 484 samples / 483 s on the performance-4x box, against a median of **18** recorded the day before. `drawsPerEncodedFrame` was **0.403** — three in five encoded frames carried no new draw at all.

Every armed counter read healthy, for the same reason as the claim above and one step worse. `fps=` and `speed=` were clean because the pump re-emits `latest` on a wall clock. The ADR 159 queue watchdog was satisfied because queue growth was **negative**. `makeFrameWatchdog` was silent because frames kept *arriving* — just fewer of them, and it asks *when did one last arrive*, not *how many*. A freeze is a gap; this has no gap.

**The floor cannot go under arrivals.** Screencast delivers only on a new composite, so a genuinely still room legitimately delivers almost nothing, and a floor that cries on a calm office is a floor nobody leaves armed. The scene itself knows the difference: while its rAF loop runs it is *trying* to draw at the requested cadence, and when it parks it hands over to the drift heartbeat, which ticks `beats`. So `beats` advancing means the room chose to be calm, and that window is not evidence of anything. `makeDrawRateFloor` judges only unparked windows. **Added 2026-09-30:** and only windows on ONE page — the /broadcast page can reload mid-run, restarting `stats()` from zero, and the delta across it read `-56.2 frames/s` on the hosted box while spending the run's single report. Counters that go backwards now re-anchor instead of being judged.

**It reports and never stops.** A half-rate stream is worth far more to a viewer than no stream, so this is the one counter that does not reach for `forceStop` — loud exactly once, because the run continues degraded for hours and a line per window buries the first one, which is the only one that says when it began.

**Sized from measurement:** 12/s sits ~33 % under the healthy median (18) and 50 % over the observed failure (8.06), judged over a 60 s window because the fault is sustained and the office's own bursts move the instantaneous rate far more than the fault does. The probe is a CDP read of `window.__office.stats()` every 10 s and is **always on** — the whole finding of the day was that the instrument which could have seen this (`deliveredFps`, behind `MUSTERD_BROADCAST_PERF`) was opt-in, so on an ordinary run nothing was watching.

**Corrected 2026-09-18 (ryder, reviewing #1541):** the falsifier as first written required a box that holds 18 draws/s, and the next claim on this page measures the real page at **15.35 draws/s idle with ~20 % box-to-box variance** — so its precondition was one this page itself retracts, and it could never be run (README rule 3). The heading keeps its original text because `wiki:check` tracks sections by it; read its falsifier as struck — ~~run a capture on a box that holds 18 draws/s~~ — and use this one instead: **run a healthy capture on any performance-4x we have, read `drawFps` p5 out of the perf JSONL, and compare it with `DRAW_FLOOR_FPS`; a p5 under the floor on a run nobody would call degraded means the floor is set too high.** The sizing sentence had the same hole: 20 % under 15.35 is 12.3, so on the boxes we have, ordinary variance *can* reach 12. The floor is therefore a **budget assertion about hardware we do not have**, not a margin under a measured healthy rate.

**Why the picture was at half speed is answered in the next claim, and the answer is not a regression.** The CPU profile on the live page is 50.4 % `(program)` — native Skia raster under canvas 2D gradients, fills and text, on a box with no GPU (`--use-angle=swiftshader-webgl`) — with the scene's own JS at ~6 % of samples. The floor stands on its own either way: whatever the cause, a half-rate picture must say so.

## The office never had headroom on the capture box, and two identical boxes differ by ~20 % — which is the whole "regression" (2026-09-17; falsify: run `/broadcast` at 1920x1080 on a fresh performance-4x with nothing else on it and read blocked-ms-per-draw; anything near 20 draws/s falsifies this) <!-- claim: other -->

Chasing the half-rate picture above produced two suspects, and **measurement killed both**.

**Occupancy is not it.** `/office-preview?quiet&n=<count>` on a dedicated performance-4x (nothing else running), 30 s per point after a 12 s settle, `beats` 0 at every point so the loop never parked. The metric is blocked main-thread ms per draw, not draws/s — a fuller room is also a busier room, and a rate alone cannot separate "each frame costs more" from "there is more to animate":

| n | 1 | 2 | 4 | 8 | 12 | 16 | 24 |
|---|---|---|---|---|---|---|---|
| msPerDraw | 39.1 | 40.0 | 39.8 | 40.8 | 42.3 | 42.7 | 43.1 |
| drawFps | 19.30 | 19.89 | 20.40 | 19.53 | 19.53 | 18.93 | 18.65 |

**24x the members buys +10 % per-frame cost.** The cost is the room — floor, walls, lighting, gradients — not who is standing in it.

**The props commit is innocent, and it looked guilty.** `1db0152a` ("Desks get three more things on them", 2026-09-16 16:41Z) took `PROP_KINDS` from five to eight and added per-desk notebooks, pens and books: +105 lines in `office-scene/render.ts`, landing *after* the healthy 03:45Z baseline and *before* the degradation, and per-*desk* rather than per-member, which even explained why the occupancy sweep came out flat. It is still not the cause. Interleaved A/B/A/B on one box, 40 s per arm, `?quiet&n=8`, both bundles built from this repo and served side by side:

| arm | old (`1db0152a^`) | new (HEAD) | old | new |
|---|---|---|---|---|
| msPerDraw | 50.2 | 54.0 | 47.4 | 47.2 |
| drawFps | 16.24 | 14.62 | 17.09 | 16.93 |

Each bundle's own two runs disagree by as much as the bundles disagree with each other. The interleaving is what makes that readable: box drift shows up *within* an arm instead of *between* arms.

**What is actually true.** The real `/broadcast` page costs **56.1 ms per draw and reaches 15.35 draws/s on an idle box** — no ffmpeg, no screencast, nothing competing. It cannot hold 20 fps before the capture pipeline takes its share, so the live 8.06 is what this hardware does with this page, not a fault that appeared. And **box-to-box variance is ~20 % on identical work** (40.8 ms at n=8 on one machine, 47-54 ms on another, same spec, same hour), which is large enough to account for "18 draws/s on 2026-09-16, 15.35 today" with no code change at all. A single-box before/after across days is not evidence here; only an interleaved A/B on one box is.

**So the open question is a budget, not a bug:** cheaper scene (the ~39 ms fixed cost is the static room re-rastered every frame — caching that layer is the obvious cut), a bigger box, or a smaller stage. The stage is **not** a flag: ADR 157 fixes it at 1920x1080, and a capture launched with `--window-size=1280,720` merely clips the viewport while the canvas stays 1080p (measured: 99.9 % blocked, gapP50 95.6 — the signature of a clipped 1080p canvas, not a cheaper one).

## The ~15 draws/s wall is the room's single-threaded draw, not the capture path or the host (2026-10-13; falsify: re-run `scripts/perf/capture-ab.mjs` on a Fly performance-4x — the x11grab arm at 25+ draws/s, or the box under 10 % idle while it holds ~15 draws/s, means the wall is total CPU or capture after all) <!-- claim: other -->

Seen twice, on two nights. The claim above (2026-09-17) found the real page at 15.35 draws/s on an idle
box, with nothing capturing. On 2026-10-13 two experiments took the capture path and then the host
out of the way, and the rate stayed about the same. Both are recorded in full in
`docs/perf/broadcast-baseline.md`.

- **Capture path changed (lane `01M4VS17JX`, #2548).** Xvfb `x11grab` in place of
  screencast→JPEG on the same performance-4x: 15.4 draws/s against 13.7–13.8, pipeline CPU 265 %
  against ~323 %, gap p95 89 ms against ~130 ms. The box sat **27 % idle** at 15 draws/s, so the
  limit is one thread, not total CPU.
- **Host changed (lane `01M4VPAP85`, #2532).** A GCP L4 GPU box doubled draws (11.0 → 19.6/s with
  GPU render) but delivered only 16.3 fps at 1080p30, and 1080p60 tripped the encoder watchdog.

So neither a cheaper capture nor a bigger box clears 30 fps. The cut is to the draw itself: the
sprite cache measuring each cached item once instead of every frame (#2568, not yet measured on the
bench), then dirty-rect repaint (lane `01M4VS1SJQ`). The spec is `docs/superpowers/specs/2026-10-13-broadcast-smooth-capture-design.md` (#2539).

## Every health signal the capture had measured the encoder, and the encoder is downstream of the freeze (2026-09-16; falsify: `Page.stopScreencast` mid-run and watch ffmpeg keep reporting a healthy rate) <!-- claim: defect -->

A frozen source keeps ffmpeg perfectly fed, because the pump re-emits `latest` by design. So every
counter the capture owned read healthy while the picture was stuck: `fps=` and `speed=` clean, and
the ADR 159 queue watchdog satisfied **because the queue was being drained exactly as it should
be**. The only counter that knew was `deliveredFps`, which is opt-in behind
`MUSTERD_BROADCAST_PERF` and therefore off on an ordinary run. One frozen frame went out for six
and a half minutes (2026-09-16, machine `84e694b2424e38`) and nothing said so.

`makeFrameWatchdog` asks the one question none of those did: **when did a frame last ARRIVE.** Armed
when the pump starts (Chrome launching and the page loading take a minute and none of it is a
freeze), swept on the pump's own timer — the tick IS the moment a frozen source is being papered
over — and disarmed on every deliberate stop.

**The threshold is measured, not chosen.** Two captures on the performance-4x box that day (778 s
total, a quiet Saturday floor) delivered a worst SECOND of 7 frames and **zero** seconds with no
frame at all: the office's ambient motion means a healthy capture never goes one second dark. 5 s is
~5x the coarsest healthy bucket and ~75x the healthy inter-frame gap. Lowering it toward the healthy
range is how this turns a still room into a restart loop, so a test pins it inside a range.

A freeze borrows `socketLossExitCode`'s judgement rather than the encoder stall's, and the
distinction is the point: an encoder that stops draining is *this run's* problem and relaunching
re-runs it, while a screencast that stops arriving is the class a relaunch genuinely fixes.

**Verified locally against `--out`, both arms and the control** (no Fly machine, no Twitch): silent
wedge at 10 s → watchdog fired at 5.0 s, ffmpeg still printing `fps=19 speed=0.955x`, exit **1**
("Ending the stream") because the run was under `RESTARTABLE_AFTER_MS`; wedge at 70 s under
`MUSTERD_BROADCAST_SUPERVISED=1` → exit **75** ("Asking the supervisor for a relaunch"); and a clean
90 s run exited 0 with the watchdog silent.

**And verified ON THE BOX** (machine `873ed1b0549138`, 2026-09-16 19:38–19:41Z, image
`d4abbeafc7a0` built with the wedge, destroyed after): two complete freeze-and-recover cycles.
ffmpeg reported `fps=20 speed=0.988x` up to the instant of each freeze — the healthy-looking number
that hid the original incident — the watchdog fired at 5.0 s both times, the process exited 75, and
`entrypoint.sh` relaunched it. **Wedge to live again was about nine seconds**, against the six and a
half minutes the same class of failure ran unreported in the morning. The local arms prove the
predicate; only this one proves the entrypoint actually reruns on 75.

### ~~Every capture leaves its tailnet node behind, and the auth key is the drift (2026-09-16)~~ FIXED the same day — verified on the box (2026-09-16; falsify: `musterd stream doctor` — it counts capture nodes and offline ones) <!-- claim: defect -->

22 capture nodes on the tailnet, 21 offline, and the entrypoint's own `▸ tailnet node:
musterd-broadcast-N` line climbing once per launch (17 → 19 → 20 across one afternoon) because
Tailscale will not hand out a hostname a live device record still holds.

**This is config drift from a documented design, not a design gap.** `entrypoint.sh`'s header
already says `TS_AUTHKEY … use an ephemeral, tagged key`, and its tailnet block already says "the
node is ephemeral by design and must not survive the machine (pair with an ephemeral+reusable auth
key)". The key in the Fly secret simply is not one. **Ephemeral is a property set when the key is
minted** — verified, it is not a flag on `tailscale up` — so nothing in this repo can make the
existing key behave that way. Minting is a human's: it happens in the Tailscale admin console, and
the value is a credential that should not pass through a transcript.

Mitigated meanwhile by `trap 'rc=$?; tailscale logout …; exit $rc' EXIT`, which hands the node back
on the way out. ~~Partial, and the limit is the common case: `fly machine destroy` and a hard stop
SIGKILL the box (2026-09-16)~~ **CORRECTED the same day, and the correction is in the mitigation's
favour.** `musterd stream stop` does not destroy the machine — it runs `fly machine stop --signal
SIGINT --timeout 30` (stream.ts), because SIGINT is the broadcast CLI's own graceful stop and `--rm`
destroys the box once the process ends. And bash **does** run an EXIT trap on an untrapped SIGINT —
measured directly rather than recalled, with a script carrying only an EXIT trap and a `kill -INT`.
So the ordinary deliberate stop IS covered. What is not: `fly machine destroy --force`, and the
SIGKILL that follows if the process outlives the 30s timeout. I under-claimed in the PR that shipped
this; the shape of the error was assuming a teardown path without reading which signal it sends. EXIT only, never INT/TERM — trapping signals
would put bash in front of the path the broadcast CLI uses for its own graceful stop, and reordering
that to tidy a device record trades a real behaviour for a cosmetic one. `rc` is captured and
re-raised because the entrypoint keys the machine's whole lifetime off 75-vs-anything-else, so a
trap whose own commands set the status would turn every restart into a teardown. Verified with a
stubbed `tailscale` that 0, 1 and 75 all survive the trap unchanged and the logout runs on each.

**CLOSED 2026-09-16 23:0xZ, and the close is measured rather than assumed.** nick minted an
ephemeral + reusable key and cleared the stale devices; the rotation is `fly secrets set TS_AUTHKEY=…
-a musterd-broadcast --stage`. **`--stage` is not optional here:** `secrets set` deploys by default,
and this app has no Fly Launch machines and no release — every capture is `fly machine run` against a
digest we build — so the default path fails with "could not find image to use for deployment; app has
no current release". The secret is stored before that error, so a run without `--stage` looks like a
failure and is not; check the digest in `fly secrets list` rather than trusting the exit.

The lifecycle, measured on one capture from birth to reap:

| | |
| --- | --- |
| 23:04:44Z | fresh node registers, online, and takes the BASE name `musterd-broadcast` — no `-N` suffix, because the names are free again after the cleanup |
| stop | node still present and still reading `online=True` **25s** after the machine was gone |
| 23:06:04Z | reaped — gone about **80s** after the stop |

Only the 2026-09-15 leftover remains, which predates the rotation.

**Two near-misreadings, both worth more than the result.** The first check used "the node count did
not grow across a stop" as the pass condition, and it passed — but the live machine's record had
already been deleted by hand during the cleanup, so a stop *could not* have added one. **A pass
condition that a confound also satisfies is not a pass**; the answer came from running a fresh node
through its own whole lifecycle instead. The second: at 25s the node was still there and still read
online, which looks exactly like a failure. Tailscale's online flag lags and ephemeral reaping is not
instant, so a verdict at 25 seconds would have been wrong in one direction or the other.

**Not separately proven, and not claimed:** whether the removal came from the `EXIT` trap's
`tailscale logout` or from the key's ephemeral property. Both were live on that machine, and an 80s
delay looks more like server-side reaping than a logout. They are belt and braces — the trap's value
is the `fly machine destroy` and SIGKILL paths, where the key still reaps but only on its own clock.

### The ack was the one CDP call nobody awaited, and both of its failures were fixed by the same line — in opposite directions (2026-09-16; falsify: stringify the ack's `sessionId`, run to `--out`, and the log must carry one refusal line and zero stack traces) <!-- claim: defect -->

`Page.screencastFrameAck` was sent with `void` and no `.catch()`, the only fire-and-forget CDP call
in the file. `ws.onclose` calls `failAll`, which rejects EVERY pending send with a `CliError`
carrying the code `socketLossExitCode` already chose — 75 when a supervisor is standing by. Every
awaited call turns that into a considered exit. The ack turned it into an **unhandled rejection**,
so Node exited 1 and `entrypoint.sh` ended a machine that was about to be restarted. Which outcome a
lost socket produced depended on whose rejection surfaced first.

**The first fix caused the second bug, and that is the part worth remembering.** A bare
`.catch(() => {})` (fd13a04a, on the closed #1466 branch) stopped the crash by swallowing
everything — including Chrome refusing the ack outright. The very next hosted run carried one frozen
frame for six and a half minutes with nothing in the log. The silence was that fix working exactly
as written and exactly as under-specified. **Two different events arrive at the same rejection
handler:** a socket closing under us during a deliberate teardown, which is expected and must be
silent, and Chrome rejecting the ack itself, which is a stream about to freeze and must be loud.
Treating them alike fails in one direction or the other, and we have now done both.

So: quiet while `stopping || restarting`, loud exactly once otherwise. Once because Chrome refuses
one per delivered frame, and at ~15/s the repeats bury the first line, which is the only one that
says when it began.

**Measured, three arms, locally against `--out`:**

| arm | exit | stack traces | cause reported | watchdog reached |
| --- | --- | --- | --- | --- |
| refusal, no catch (pre-fix) | 1, unhandled rejection | **10** | no | no — the process died first |
| refusal, with this fix | 1, a considered `forceStop` | **0** | yes, once | yes |
| clean start and stop | 0 | 0 | no false line | n/a |

The middle row exits 1 rather than 75 and that is correct, not a miss: a stringified `sessionId` is
refused from the first frame, so the run never reaches `RESTARTABLE_AFTER_MS` and
`socketLossExitCode` chooses 1 by design. What changed is where the 1 comes from — a considered stop
instead of a crash — and that the watchdog now gets to run at all.

### Every relaunch claimed a deploy it could not know about (2026-09-16; falsify: wedge the screencast on the box and read the entrypoint's line under the watchdog's) <!-- claim: defect -->

`entrypoint.sh` printed `▸ restarting the stream on the rebuilt daemon code` for **every**
`RESTART_EXIT_CODE`, and 75 has three causes: a daemon rebuild, a lost DevTools socket
(`socketLossExitCode`), and now a frozen picture. Two of the three were being reported as the
first. Read on the hosted falsifier above: a deliberately wedged screencast relaunched twice, and
both relaunches logged as the rebuilt daemon code — which tells an operator scanning the log that a
deploy landed and there is nothing to investigate.

It predates the watchdog (the socket case was already misreported); the watchdog adds a third cause
and is what surfaced it. The line now says `▸ relaunching the stream (ran Ns) — reason on the line
above`, because the stream prints its own reason on stderr immediately before exiting and the
supervisor genuinely does not know which one fired. **A restart reason the supervisor cannot know is
one it must not assert** — the same failure as a counter that reads healthy while the picture is
frozen, one layer up.

### ~~The 6.5-minute freeze is not reachable on `main`, and that surprised me (2026-09-16; falsify: stringify the ack's `sessionId` on main and watch it die on an unhandled rejection instead of freezing)~~ STILL TRUE ABOUT THE FREEZE, INVALID ABOUT `main` SINCE 2026-09-16 — #1500 (`2f1eae77`) attached the `.catch()`, so the falsifier as written no longer reproduces (2026-09-19; falsify: stringify the `sessionId` on `main` and watch it report once and stop, not exit on an unhandled rejection) <!-- claim: other -->

The first falsifier I wrote reproduced the original bug — a stringified `sessionId` — and it did
**not** freeze the stream. It crashed the process. ~~On `main` the ack is `void page.send(...)` with
no `.catch()`, so Chrome's "Invalid parameters" becomes an unhandled rejection and Node exits.~~
**INVALID SINCE 2026-09-16, struck 2026-09-19.** That sentence described `main` for about six hours.
#1500 (`2f1eae77`) landed `page.send(...).catch(ackRefused)`, so on `main` today a refused ack is
reported exactly once and the process does **not** exit on an unhandled rejection — delivery stops,
and `makeFrameWatchdog` force-stops with the code `socketLossExitCode` chose. It is struck rather
than deleted because it was on `main` and someone may have read it. The
six-and-a-half-minute silent freeze was a property of the closed #1466 branch, whose gate added a
`.catch()` that swallowed exactly that rejection.

Two things follow. The watchdog is still right, because a refused ack is only ONE way frames stop
arriving and the others (a wedged compositor, a renderer hang, a silently stopped screencast) raise
nothing at all — which is why the real falsifier had to be `Page.stopScreencast`, not a bad ack.
And, ~~noted but **not fixed here**: that unhandled rejection exits 1, so a supervised stream will not
restart from a recoverable ack failure that `socketLossExitCode` would otherwise call restartable.~~
**FIXED 2026-09-16 by #1500** — the gap this paragraph left open is the lane it became
(`01M2NWVH4G`, accepted 2026-09-19).

## Both ffmpeg inputs ran an 8-packet queue (2026-09-03; falsify: watch the log in the first seconds of a stream) <!-- claim: defect -->

Within a second of going live, ffmpeg reported against **both** inputs: `Thread message queue
blocking; consider raising the thread_queue_size option (current value: 8)`. Eight packets is a third
of a second at 25fps, so one missed frame deadline in Chrome blocks the reader instead of being
absorbed — a stutter the viewer sees. `image2pipe` and `pulse` now each get `-thread_queue_size 512`
(~20s of video, a few MB on an 8 GB box) placed **before** their own `-i`, since an ffmpeg input
option written after its input belongs to the next one. `anullsrc` is exempt: a synthetic source
cannot fall behind.

This raises the ceiling on a hiccup; it does not make the pipeline faster. Measured the same night:
load average **5.50 / 4.54 / 2.49 on 4 cores**, chromium ~2.2 cores across four processes, ffmpeg
0.83 — Chrome's render is still the bottleneck this page has recorded since 2026-07-29, and
`performance-4x` still cannot step down. If `speed=` sits below 1.0x, no queue size fixes that.

## `Page.navigate` ran on a deadline sized for local calls (2026-09-03; falsify: cold-boot a machine and time `streaming (rtmps)` → `◉ live`) <!-- claim: defect -->

`CDP_TIMEOUT_MS` is 15s and applied to **every** CDP call, but the startup calls are not alike.
`Page.enable`, `Runtime.enable` and `Emulation.setDeviceMetricsOverride` are local bookkeeping that
answer in microseconds. `Page.navigate` resolves only when the navigation **commits** — Chrome
reaching the laptop's daemon across Tailscale and beginning the document, on a cold machine, with a
Chrome seconds old, beside an encoder already burning most of a core.

Machine `8799e4b0267668` logged `streaming (rtmps)` at 18:44:40 and died at 18:45:07 on `✗ Chrome did
not answer Page.navigate in time` — fatal, `--restart no`, and the ADR 293 supervisor then spent a
flap slot relaunching it. The margin was never comfortable: the machine that *survived* the same
night took **16s** from `streaming` to `◉ live`, and that span contains navigate **plus**
`waitBroadcastReady`'s own poll, so navigate alone was close enough to the 15s bar that which side it
landed on was chance. This is the 2026-08-18 death class, and the supervisor was built to survive it
rather than prevent it.

`cdpTimeoutFor(method)` now gives `Page.navigate` 60s and leaves everything else at 15s.
Deliberately **not** a new global default: the 15s ceiling is what makes a wedged compositor
detectable, and raising it everywhere would trade a startup flake for a hang nothing reports.
Note `waitBroadcastReady` already had its own 30s budget for exactly this reason — navigate is the
same kind of wait and had simply never been given one.

## A digest the registry has not published yet is not a failed start (2026-09-03; falsify: `stream build` then `stream start` immediately) <!-- claim: defect -->

`stream start` failed **twice** with `MANIFEST_UNKNOWN ... manifest unknown [http 404]` against a
digest `stream build` had just pushed — while flyctl's own `image found: img_…` line said it had
resolved it — then succeeded about four minutes later with nothing changed. Registry propagation lag
against a digest-pinned launch. Pinning the digest is right and stays (a tag can resolve to a stale
image; a digest cannot); what was wrong is that a failure which heals itself in minutes was fatal.

Worse than the failed command: `start` records `desired: live` **before** launching, on purpose
(ADR 293), so giving up handed the supervisor a retry loop that would have burned all three flap
slots on a 404 that was about to stop happening, then stood down and asked a human about a
non-problem. On the night, the stream came back only because the state was stopped by hand first.

`start` now re-attempts up to 4 times, 45s apart, **only** on that signature. Every other launch
failure — no capacity, bad secrets, a broken entrypoint — stays fatal on the first try, because a
retry loop over real errors is how you bill for machines that were never going to run. Same reasoning
as the prerender crawl's `retryCount: 3`, which exists because one transient fetch failure used to
fail an entire build.

**The retry reaps before it relaunches (added 2026-09-15).** A `MANIFEST_UNKNOWN` exit is not proof
that no machine was created — and that is the other half of the sentence the 2026-09-03 note left
off. `fly machine run` creates the machine and *then* the VM fails to pull the not-yet-published
digest; the machine keeps trying and comes up on its own once the registry catches up. So the attempt
being retried may already have produced the very thing being retried for. Observed live 2026-09-15
starting the hosted broadcast: the "failed" first attempt's machine went `◉ live` 52s later unaided,
and 3s before that the retry had launched a **second** performance-4x against the same stream key —
both published, and only Twitch refusing the second publisher kept it to one machine. That is luck
standing in for a guard, and it is the exact 2026-09-03 duplicate-launch (`supervisor` §above),
reached through `start`'s own retry rather than the supervisor's crash predicate. `start` now asks
the same `occupiedMachines` question its top-of-function guard asks *before each relaunch*: if the
last attempt left an occupying machine, it waits for that machine instead of racing it. The 45s sleep
was always the right wait; only the second `fly machine run` was wrong.

## `stream doctor` passed an image older than the capture code it needed (2026-10-15; falsify: record an image at a commit before #2595, run `musterd stream doctor` — a green `capture image built` falsifies the fix) <!-- claim: defect -->

On 2026-10-15 doctor reported `✓ capture image built — sha256:9d6a43c3feaa` for an image built on
2026-10-12. ADR 594 (#2595, 2026-10-15) taught the box's `musterd broadcast` to hand the page its
observer seat; the old image's CLI had no `addScriptToEvaluateOnNewDocument` and its `build.json`
said `builtAt 2026-10-12T23:47`. With no seat handed over, the page could not mint one (ADR 580),
never reported ready, and every machine exited after ~30 s with `✗ the broadcast page never
reported ready`. The supervisor relaunched three times in 30 minutes and stood down. `stream build`
then `stream start` brought it up on the first try (`◉ live 0e2b410`, 5 s after streaming began).

The check only knew that an image existed. `stream build` now records the commit it built at in
`~/.musterd/stream/image.json`, and doctor fails the image when `git log <commit>..origin/main` has
commits on the paths the box runs (`CAPTURE_PATHS` in `packages/cli/src/broadcast/hosted.ts`), when
the record predates the commit field, or when git cannot compare. `stream start` prints the same
finding as a warning and launches anyway. `origin/main` is as this checkout last fetched it.
