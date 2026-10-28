# 029 — The act lane on revive, read once: six act-lane waits, all izzo's, median 2.9 h against 4.5 s on the launch lanes; miley never came due and grokbot woke only for work orders

> **Status:** 2026-10-28, lane 01M5WVDJ2T (lazara), asked for by nick. Pre-registered 2026-10-26
> ([manifest](./act-lane-manifest.md), amended at the switch, #3356) before the first act-lane wake;
> window 2026-10-26 19:33Z → 2026-10-28 19:35Z; read 2026-10-28 ~20:15Z with the
> [`actlane.py`](./act-lane/2026-10-26-switch/actlane.py) written before the switch, output in
> [`read.json`](./act-lane/2026-10-26-switch/read.json). **R7a:** median `waited` on act-lane wakes
> **10,530 s (2 h 55 m)**, n = 9 wakes of which 6 carry a `waited`; launch-lane seats over the same
> 48 h **4.5 s**, n = 38. Rule ≤ 120 s acted / ≥ 900 s did not — **the lane did not act**. **R7b:** no
> kill-rule breach; the highest act-lane seat-day is grokbot on 10-27 at **$2.78**. The verdict rests
> on six numbers from one seat in one evening; see [How far it reaches](#how-far-it-reaches).

## Question

With izzo, miley and grokbot enrolled on the act lane ([ADR 735](../decisions/735-act-lane-the-seat-ends-its-turn.md))
and the rest of revive on the launch lanes, does a directed act reach its seat sooner, and at what rate
and cost of wakes? No claim about CooperBench, pass rates or the hosted seat.

## Setup

- **Seats and switch times:** izzo 2026-10-26 ~19:33Z, miley and grokbot ~19:40Z, from nick's Workspace on
  mac.lan; hourly cap at the team default (2), unchanged.
- **Fix time** (`--fix-at`): **2026-10-26T20:11:52Z**, the first daemon restart on a build containing
  #3358 (`6ba291e`, merged 19:55:32Z) — `fbe03c89` in the auto-refresher log. That is this read's own
  machine's daemon; the hub's refresh time is not in anything this seat can read, and its refresher runs
  the same 2-minute tick with the same settling rule.
- **Log:** the hub's `~/.musterd/host.log` (mac.lan), fetched 2026-10-28 ~20:12Z. The manifest also named
  Nicks-Laptop.local's host log; this seat cannot read it. All three act-lane seats are hosted on
  mac.lan, so their wakes are in the log that was read; launch-lane seats hosted on the laptop are not,
  and the launch-lane baseline is mac.lan's alone.
- **Command:** `actlane.py --since 2026-10-26T19:33Z --until 2026-10-28T19:35Z --act-lane izzo,miley,grokbot
  --fix-at 2026-10-26T20:11:52Z --switch-at izzo=…19:33Z,miley=…19:40Z,grokbot=…19:40Z hub-host.log`.
- **Read once — with one disclosure.** The same script ran at 16:52Z the same day as a dry run to check the
  command, so the numbers were seen ~3 h before the window closed. Nothing was changed after it; the
  final read's R7a and R7b are identical to the dry run's (no act-lane wake fell in the last three hours).

## Results

### R7a — time from act to wake

| Seat | Act | From | Act sent | Woke | `waited` |
| --- | --- | --- | --- | --- | --- |
| izzo | ask | alfie | 10-26 19:51Z | 22:55Z | 3 h 4 m |
| izzo | message | big-body | 10-26 20:01Z | 22:57Z | 2 h 56 m |
| izzo | ask | slippy | 10-26 20:36Z | 23:55Z | 3 h 19 m |
| izzo | ask | lazara | 10-26 21:42Z | 23:58Z | 2 h 16 m |
| izzo | ask | slippy | 10-26 22:00Z | 10-27 00:55Z | 2 h 55 m |
| izzo | ask | slippy | 10-26 22:12Z | 10-27 00:59Z | 2 h 47 m |

The other three act-lane wakes are board `work_order`s (izzo and grokbot 10-27 05:30Z, grokbot 10-28
05:30Z), which carry no `waited`. Median of the six: **10,530 s**. Launch lanes, same window: 38 wakes,
median **4.5 s**. All six acts were sent after izzo's switch, so none is backlog under the manifest's
rule; the two backlog wakes are grokbot's (two `message`s from stanley, 838 h old, before the fix).

**The daemon's own clock agrees.** [ADR 749](../decisions/749-wake-wait-on-the-report.md)'s
`report residency` `by_seat[].waited_ms` for izzo holds 2 h 16 m, 2 h 47 m, 2 h 55 m, 2 h 56 m and 3 h 4 m
within a minute of the host's values (lease time vs the host's rounded print); 3 h 19 m is not among them.
That list is not windowed and has no timestamps, so it cannot give R7a by itself.

### R7b — rate and cost

| Seat | Wakes by day | $ by day |
| --- | --- | --- |
| izzo | 10-26: 4 · 10-27: 3 | $0.05 · $0.02 |
| grokbot | 10-27: 1 · 10-28: 1 | $2.78 · $0.24 |
| miley | none | — |

Median $ per act-lane wake: **$0.01** (9 priced); launch lanes: **$0.40**. Kill rule ($10 in a seat-day):
no breach.

### Beside the rules

- **Plain `message` wakes:** 1 of 9 (izzo, from big-body) — the kind the launch lanes never wake on.
- **miley never came due.** No `wake due: miley` line falls in the window. Every miley line in the
  log, including its 26 `wake FAILED` lines (`no roster occupancy within the verify window`) and 516
  `poll failed` lines on a version-1 binding at `/Users/nick/agents-miley`, sits before the window.
  miley's own sessions were busy throughout (it shipped and resolved several office lanes in the window),
  so its directed acts were read by a live session, not by a wake.
- **grokbot** came due only for the two backlog messages and two work orders.
- **Failed-wake counts** in `read.json` are whole-log counts (the script does not window them); none of
  the act-lane seats has a failed wake inside the window.

## Why the waits were long — what the log can and cannot say

Each of izzo's six wakes landed between :55 and :59 past an hour, two to an hour, 2–3 h after the act.
The host log carries **no line for izzo between an act becoming due and its wake** inside the window —
no `wake deferred`, no cap line — and the log has **no timestamps of its own**, only lease ULIDs. The
same stretch shows the host restarting repeatedly (18 refusals asking for an administrator-minted
credential) and 53 polls that could not reach the team server (counted from the first line carrying an
in-window lease). So the read cannot say whether
izzo's acts waited on the hourly cap, on a held attended session, or on a host loop that was down.
Before the window, the same log has 161 `wake deferred: izzo — an attended … session … is open … idle
but not closed` lines, which is the likeliest single cause, but it is not shown inside the window.

## How far it reaches

- R7a's "did not act" is the pre-registered verdict and stands. It rests on **six waits, one seat, one
  evening (19:51Z–22:12Z sends on 10-26)**; after 10-27 01:00Z, no act-lane seat was woken by a directed
  act at all in 42 h.
- It does not say the act lane is slower than the launch lanes in general: the launch-lane median is over
  38 wakes on other seats, most of them where nothing else was holding the seat.
- The cost side is clear: act-lane wakes were cheap ($0.01 median) and rare (9 in 48 h on three seats).

## Product gaps the read hit

1. **The host log cannot explain a wait.** A due act that is held prints nothing until it wakes, and no
   line carries a time. ADR 749 already moved the wait onto the daemon; the hold reason (cap, attended
   session, host down) is the missing column.
2. **The act lane did not reach a seat whose own sessions stay open.** miley and izzo were attended much
   of the window; the act lane only shortens a wait when nothing else is holding the seat.

## Decision for nick

The manifest leaves the seats on the lane or not as nick decides. Nothing in R7b argues for taking them
off (no seat-day above $2.78); R7a gives no evidence the lane helps.
