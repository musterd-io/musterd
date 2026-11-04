# 031 — CooperBench rider 7, stopped at the smoke pair: the act lane woke the seat 15 times without a failure, and one pair cost $17.80 of the $25 stop, because a resumed wake pays for the whole transcript and each act waits for the last wake's session to lapse

> **Status:** 2026-11-04, lane 01M6M3YG37 (lazara), asked for by nick. Pre-registered the same day
> ([rider 7](./cooperbench/riders.md#rider-7-finding-028s-loop--the-musterd-arm-on-the-act-lane-where-a-seat-ends-its-turn-and-the-host-wakes-it-on-the-next-act),
> [manifest](./cooperbench/rider7-manifest.md), #3831) under the gate nick amended on
> [finding 030](./030-act-lane-reread.md). **No rule was read.** The manifest's smoke pair (step 4) ran
> 21:12–21:34Z and was stopped by the author before any measured pair, at about **$17.80** of model spend
> against the **$25** hard stop; nick then chose to stop and write it up rather than fund a second run
> ("write it up", in session). What follows is a cost read of one pair, with no claim about pass rate,
> conflicts or the three pre-registered rules.

## Question

Does the act lane replace the turns a CooperBench pair spends waiting, at what cost, and how fast does
the host wake a seat? The manifest's R7a/R7b/R7c would have read that over the 10 `core` pairs. The
smoke pair was the gate on the run shape: a wake leased and resumed in each container, a priced wake
row per wake, both patches read.

## Setup

The [manifest](./cooperbench/rider7-manifest.md) and the
[run log](./cooperbench/pilot-runs/2026-11-04-rider7/run.log). Deploy from main `7c024748` (the arm in
#3831), Claude Code 2.1.307, musterd 0.7.0; gate and hold smokes PASS. One pair, `pallets_click` 2068,
`claude-sonnet-4-5`, `--git`, `MUSTERD_ARM_LANE=act`: the team policy `lane act`, `hourly_cap 60`,
`timeout 60m`, `transcript_max 256 MiB`, `tool_policy seat-policy`; each seat enrolled from its container,
`musterd host` in the container under its own label; the two "wait in one call" sentences removed from
the instruction. Everything the manifest's treatment table names was in force.

## What the pair showed

### The run shape works

| | agent1 | agent2 |
| --- | --- | --- |
| Enrolled (row, grant, host key, registry) | yes | yes |
| Wakes leased | 14 | 1 |
| Of which resumed / fresh | 13 / 1 | 0 / 1 (a `handoff` is delivered portable, so fresh) |
| Failed / deferred | 0 / 0 | 0 / 0 |
| Spawn → roster | 9 s each | 17 s |
| Patch written when stopped | no | yes (21:30Z) |

The seat ended its turn, the host resumed it on the next act, and the wake carried the act: 15 of 15
wakes answered. Nothing in the adapter, the enrollment or the host failed.

### The cost: a resumed wake pays for the whole transcript, every time

agent1's fourteen wakes, in order, with the act that triggered each, its wait and its price:

| # | Act | Waited | Session | Cost | Wall |
| --- | --- | --- | --- | --- | --- |
| 1 | message, agent2 | 24 s | fresh | $0.17 | 30 s |
| 2 | message, board | 37 s | resumed | $0.26 | 38 s |
| 3 | message, agent2 | 46 s | resumed | $0.42 | 47 s |
| 4 | message, agent2 | 2m8s | resumed | $0.53 | 33 s |
| 5 | message, agent2 | 2m9s | resumed | $0.89 | 106 s |
| 6 | message, agent2 | 3m21s | resumed | $1.01 | 23 s |
| 7 | message, agent2 | 2m24s | resumed | $1.07 | 17 s |
| 8 | message, agent2 | 3m7s | resumed | $1.19 | 26 s |
| 9 | request_help, agent2 | 56 s | resumed | $1.30 | 27 s |
| 10 | message, agent2 | 4m38s | resumed | $1.37 | 17 s |
| 11 | message, agent2 | 5m35s | resumed | $1.43 | 14 s |
| 12 | message, agent2 | 5m42s | resumed | $1.50 | 14 s |
| 13 | message, agent2 | 5m17s | resumed | $1.57 | 17 s |
| 14 | message, agent2 | 4m28s | resumed | $1.64 | 19 s |

$14.34 for agent1's wakes, $0.31 for agent2's one, $3.15 for the two first calls: **about $17.80** in 22
minutes on one pair. Rider 6's whole ten-pair run cost $18.45. The price of a wake rises with the
transcript it resumes, by about $0.10 a wake here, while the work done in it stays at 15–30 s. The
design note raised the team's transcript bound from 256 KiB to 256 MiB so a resume would never be
refused for size and the agent would keep its working context; that removed the one bound ADR 131
puts on resume cost. `spend_guard.py` could not stop it: it reads each pair's `result.json`, written
only when the pair ends.

### The wait: each act waits for the last wake's session to lapse

The waits grew from 24 s to 5m42s over the same fourteen acts. ADR 753's holds on the report say what
held each one:

| Waited | `reclaimable` | `present` | `passed` |
| --- | --- | --- | --- |
| 24 s | 24 | — | 0 |
| 56 s | 50 | 6 | — |
| 128 s | 79 | 30 | 19 |
| 201 s | 90 | 92 | 19 |
| 278 s | 190 | 30 | 57 |
| 342 s | 247 | 20 | 74 |

`reclaimable` is ADR 753's second gate: the seat's last session can still be reclaimed, so the daemon
does not lease a new wake. After a wake's `claude` process exits, that session stays reclaimable for a
window, and the next act, which on a two-seat task arrives within a minute, waits out the window. The
window grows with the backlog: with agent2 sending faster than agent1's wakes could clear, each act
queued behind a session that had only just been leased. No `hourly_cap` hold (the cap was 60), no
`snoozed`, and the host's 10 s poll (`passed`) is a minor share. R7c's bound was 2 min; 10 of these 14
would have read "did not act".

## How far it reaches

- One pair, stopped at 22 minutes, with one seat doing nearly all the waking. It is enough to say the
  act lane as configured by the manifest costs more per pair than the loop it replaces and wakes
  slower than its gate promised; it is not a read of R7a, R7b or R7c, and none is claimed.
- The two causes are product facts, not arm bugs, and both are measured here for the first time on a
  seat that is never attended: finding 030 could not see them under revive's attended sessions.
- The wiring (enroll in the container, host in the container, capture hooks, the permission floor) is
  sound and stays in the arm behind `MUSTERD_ARM_LANE=act` for a later run.

## Product gaps the read hit

1. **A resumed wake has no cost bound once the transcript bound is lifted.** The ADR 131 ladder bounds
   resume by transcript bytes only; a seat woken every minute on a growing transcript pays more each
   time. A per-wake or per-hour budget on the act lane, or a resume that carries a compacted context
   rather than the whole transcript, is the fix; the team's `budget_usd` knob is per seat, not per
   wake, and was not set here. Lane: see below.
2. **The reclaimable window holds the next act behind the last wake's session.** On the act lane the
   seat's own just-ended wake is the thing holding its next wake. A seat on the act lane should pass the
   reclaimable gate once its wake process has exited and reported, or the lane should resume into the
   reclaimable session instead of waiting for it to lapse. Lane: see below.
3. **The spend guard reads results, not wakes.** A pair that never ends never reaches it. Reading the
   pair daemon's `residency.wake_cost` rows, or the host log, during the run would have stopped this
   pair at $5.

## Decision for nick

Taken in session: stop here and write it up. Rider 7 stays pre-registered and unread; its arm change
stays on `main`; the manifest's rules are untouched. A second run waits on gaps 1 and 2.
