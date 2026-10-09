# 555 — A reconnect Twitch refuses is retried in the machine, not ended

- Status: accepted
- Date: 2026-10-09
- Deciders: nick ("yes", to retrying inside the machine with a cap, 2026-10-09)
- Lane: `01M4FCBGTFPCB4SYQCSSKG6KFR`, inc 5 of the stream-never-offline arc (inc 4: ADR 553)
- Builds on: ADR 553 (decision 2, "the floors stay", is what this changes), ADR 551,
  `docs/wiki/broadcast-stream.md`

## Context

ADR 553 made a dead RTMP session restart the broadcast inside its machine. Its first measurement on the box
(2026-10-09, machine `80e450b6543428`, image `b8c90e58e30e`) showed the restart working and the machine ending
anyway:

| time (Z) | event |
| -------- | ----- |
| 03:45:48 | 3 s `tcp-reset`; ffmpeg ends, the stream asks the supervisor for a relaunch |
| 03:45:55 | `◉ live` on the same machine, 7 s after the reset |
| 03:45:56 | Twitch closes the new session (`tls … End of file`); ffmpeg ends |
| 03:45:58 | the broadcast returns 1; `entrypoint.sh` exits; the machine ends |

## Problem

`sinkLossExitCode` asks for a rerun only if the run lasted `RESTARTABLE_AFTER_MS` (60 s), so a rejected key
or a broken config cannot loop. The retry ran 7 s, so it was judged by that floor and ended the machine. But
the retry was not a first run that never worked: the stream had been live for 132 s in this machine. The
floor answered "is this configuration broken?" for a stream that had already answered no. Twitch refusing a
reconnect made seconds after a reset is not a bad config, and a restart that cannot survive it only moves
the failure from the first run to the second.

## Decision

1. **A rerun after a restart is a retry, and the stream is told so.** `entrypoint.sh` counts the runs in a
   row, since the last one that lasted 60 s, that ended short, and hands the count in
   `MUSTERD_BROADCAST_SINK_RETRY`. It is unset on the machine's first run.
2. **A retry that ends short is restarted again, up to `SINK_RETRY_MAX` (6) in a row.** `sinkLossExitCode`
   returns 75 for a supervised sink loss when the count is set and below the cap, whatever `ranMs` is. At the
   cap it falls back to the 60 s floor, which a short run fails, so it exits 1 and `ensure` takes over as
   before.
3. **The loop waits longer after each short run.** 10 s after a proven run or the first short run (the
   existing floor), 20 s after the second, 30 s after each later one. The stream does not choose the wait;
   the entrypoint does.
4. **The floors for a first run are unchanged.** A first run that ends before 60 s ends, so a rejected key
   in a new machine does not loop. Unsupervised runs, a stop that was asked for, and a clean ffmpeg exit
   are as ADR 553 says. The cap and wait apply to sink loss only; `socketLossExitCode` keeps its floor.

## Consequences

A key revoked mid-stream now ends the machine after about 2.5 minutes (6 retries, 10 + 20 + 30 × 4 s of
waiting plus the runs) instead of at the first retry, and each retry bills as the machine does. That is
inside the 96 s-plus recovery `ensure` gave before, and it ends the same way.

A sink that drops every few minutes and recovers each time never reaches the cap, because a run that lasts
60 s resets the count. ADR 553's deferred cap on restarts per window is still open.

How long Twitch refuses a reconnect is not known. The cap and wait are a guess sized to about a 2.5 minute
refusal. The experiment below measures it; change the numbers from that, not from this ADR.

ADR 553 decision 2 is changed by this ADR: a supervised retry is not held to the 60 s floor.

## Observability & Evaluation

**Traces.** Per retry: `✗ ffmpeg ended (code N) — the sink dropped. Asking the supervisor for a relaunch.`,
`▸ relaunching the stream (ran Ns)`, then `◉ live`. A retry that Twitch accepts keeps the machine id and ends
the lines. A run that reaches the cap ends with `Main child exited normally with code: 1`.

**Eval.** Dataset: the hosted box, one reset per run. Baseline (before, 2026-10-09, image `b8c90e58e30e`): 3 s
`tcp-reset` -> `◉ live` in 7 s, session closed by Twitch 1 s later, machine ended, `ensure` replaced it.
After (2026-10-09, image `917843deea30`): same machine, two relaunches (Twitch closed the first at 04:05:39,
accepted the second), `◉ live` that held 14 s after the reset. One run.

**Experiment.** On the hosted box, `iptables -I OUTPUT -p tcp --dport 443 -j REJECT --reject-with tcp-reset`
for 3 s while the stream is live. The machine id must be unchanged and `fly logs` must end with a `◉ live`
that stays up; read off how many retries and how many seconds Twitch took to accept. A new machine id, or
six retries and the machine ending, falsifies this ADR.
