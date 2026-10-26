# 737 — A stalled stream is a crash

- Status: accepted
- Date: 2026-10-26
- Relates to: ADR 293 (desired state + supervisor; this widens its crash predicate), ADR 159
  (graceful stop + in-process stall watchdog), ADR 157 (hosted stream contract)

## Context

ADR 293's supervisor asks one question each minute: does a machine occupy the app? A machine gone
while the state file says live is a crash. A machine present is healthy. The second half is the
2026-09-03 duplicate-launch guard: a booting machine reads as absent if you ask "is it running",
and relaunching over it put two machines on one Twitch key.

On 2026-10-12 that guard hid a dead stream for about 3.5 hours (lane 01M4S5HS81). Inside machine
`6836601b`, Chromium was killed and restarted around 18:44Z. After that the screencast stopped
feeding ffmpeg, which stayed alive but idle; its last progress line was at 19:30Z. Twitch dropped
the stream. The machine stayed `started`, so `ensure` was a no-op every minute and `stream
status` said `◉ live`. miley fixed it by hand with `stop` + `start`.

ADR 159's in-process watchdog did not catch it. It watches the page's draw counter, and the page
was drawing; the break was between the page and the encoder.

## Problem

The supervisor needs a liveness signal that comes from the encoder's own output. That signal must
not bring the duplicate-launch race back: a booting machine is not a stall.

## Decision

**A started machine with no encoder progress for 3 minutes is a crash.** The progress signal is
ffmpeg's own `frame=… time=…` line, which it writes about once a second while it encodes and never
while it is starved. The supervisor reads it from the machine's log (`fly logs --machine <id>
--no-tail`), which `ensure` can already reach and which outlives the machine's filesystem.

- **Boot grace.** A machine younger than 4 minutes (from Fly's `created_at`) is never checked.
  The image pull, tailnet, Chrome and first page all come before ffmpeg's first line.
- **Unknown is never a stall.** A failed log read, or a buffer with no progress line at all, means
  no action. The supervisor acts only on a progress line it can see going stale.
- **Stop now, relaunch next tick.** A stall stops the machine with the graceful SIGINT stop. It
  does not relaunch in the same tick, where a slow `--rm` teardown could overlap the new machine on
  the same Twitch key. The next tick finds no machine and relaunches it.
- **One event, one charge.** The restart is charged to the ADR 293 flap budget (3 in 30 minutes)
  when the stall is found. The state file records `stallStoppedAt`, so the relaunch on the next
  tick is the same event and is not charged twice. With the budget spent, a stall stands down and
  asks a human, as a crash does.
- **`stream status` says it.** A stalled machine reads `◉ started but not streaming · no encoder
  progress for Nm`, not `◉ live`. The check is the same one the supervisor uses.

Twitch's own stream state was considered as the signal and not taken. It needs a Twitch API
credential the supervisor does not hold, and it cannot tell "we stopped sending" from "Twitch is
down". The encoder's progress line is first-hand and needs nothing new.

## Consequences

- A starved encoder costs about 4 minutes of dead air: 3 to notice, up to 1 more for the next
  tick to relaunch. That replaces hours.
- Each tick with a machine past its boot grace makes one extra `fly logs --no-tail` call.
- Fly's log buffer is short: about 90 seconds of lines on 2026-10-26 with `--perf` on, since its
  one-a-second samples share the buffer. ffmpeg's lines still appear in it. If something on the
  machine ever floods the buffer with other lines, the progress line falls out and the check reads
  "unknown" and does nothing. That is the safe direction.
- A stream whose encoder is healthy but whose RTMP connection to Twitch has dropped is not caught.
  ffmpeg exits on a write error in that case, which is the existing crash path.

## Observability & Evaluation

- **Traces:** a stall writes the supervisor's log line (`stall detected: started but no encoder
  progress for Nm`) and stamps the restart ledger and `stallStoppedAt` in the state file.
  `stream status` shows it while it lasts.
- **Eval:** `streamState.test.ts` and `stream.test.ts` pin the cases: fresh progress is a noop,
  unknown is a noop, a stale line past the grace stops but does not relaunch, the next tick
  relaunches uncharged, a spent budget stands down, and a deliberate stop is never overridden.
- **Experiment:** n/a — a supervisor rule with a fixed incident to answer. The read is whether
  the next starved encoder is back within about 5 minutes, which the state file's ledger records.
