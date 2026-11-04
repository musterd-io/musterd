# 030 — The act lane re-read on the ADR 753 build: median free wait 3.8 min over 20 waits, "part of it"; the seats were attended 99% of the time, and on the one busy evening the hourly cap held izzo for two hours

> **Status:** 2026-11-04, lane 01M62BJWMQ (lazara), asked for by nick. Pre-registered 2026-10-28
> ([manifest, "Re-read on the ADR 753 build"](./act-lane-manifest.md#re-read-on-the-adr-753-build))
> before the window opened; window: acts sent 2026-10-29 00:00Z → 2026-11-04 00:00Z; read 2026-11-04
> ~06:00Z, one `musterd report residency --json` ([`report.json`](./act-lane/2026-11-04-reread/report.json))
> through the pre-written [`reread.py`](./act-lane/2026-10-29-reread/reread.py), output in
> [`read.json`](./act-lane/2026-11-04-reread/read.json). **R8a:** median **free wait 227.6 s (3.8 min)**,
> n = 20, unobserved share 10.1% (valid). Rule ≤ 2 min acted / ≥ 15 min did not — **part of it**.
> **R7a:** median raw wait **59,271 s (16.5 h)** on act-lane seats (n = 20) vs **11.7 s** on every other
> seat (n = 53). **R7b:** no kill-rule breach; the only priced act-lane seat-day is izzo on 10-29 at
> **$0.24**.

## Question

Finding 029 said the act lane did not act, but could not say what held the acts. With ADR 753 recording
which gate held each enrolled seat, does the lane shorten the wait once the seat's own sessions are taken
out of it? Same three seats (izzo, miley, grokbot), same lane, same cap of 2 wakes an hour, on mac.lan.

## Setup

- **Source:** the hub's `report residency --json`, read from this seat's Workspace (the Linux box) with
  the CLI bound to the revive hub; the report carried 76 wakes team-wide over its 7-day window, so it is
  the hub's data, not a local replica. No host log, no model calls.
- **Command:** `python3 -I reread.py --since 2026-10-29T00:00Z --until 2026-11-04T00:00Z --act-lane
  izzo,miley,grokbot report.json`, exactly as pre-registered.
- **Read once — with one disclosure.** On 2026-10-29 at 04:28Z, four hours into the window, this seat
  ran `report residency` once to confirm the ADR 753 `holds` block was being written; it showed holds
  only, and no number from it was kept. Nothing in the script or the rules changed after that.

## Results

### R8a — free wait, the wait minus the seat's own holds

Free wait is the wait minus the time the seat was `present`, `snoozed`, `reclaimable` or `lease_live`.
Twenty act-lane waits fall in the window: 11 izzo, 9 miley, none grokbot.

| Seat | Act sent | Raw wait | Free wait | Largest gate | Of which `hourly_cap` |
| --- | --- | --- | --- | --- | --- |
| izzo | 10-29 01:07Z | 6.4 h | 126 m | present 64% | 124 m |
| izzo | 10-29 01:20Z | 7.2 h | 142 m | present 54% | 128 m |
| izzo | 10-29 01:20Z | 7.2 h | 143 m | present 54% | 128 m |
| izzo | 10-29 03:05Z | 6.4 h | 154 m | hourly_cap 36% | 139 m |
| izzo | 10-29 04:26Z | 5.1 h | 138 m | hourly_cap 40% | 124 m |
| izzo | 10-29 04:44Z | 5.8 h | 160 m | hourly_cap 40% | 139 m |
| izzo | 10-29 04:59Z | 5.6 h | 160 m | hourly_cap 41% | 139 m |
| miley | 10-30 01:38Z | 22.6 h | 983 m | unobserved 73% | 0 |
| izzo | 10-30 04:06Z | 2 s | 2 s | passed 100% | 0 |
| izzo | 10-30 04:14Z | 20.0 h | 961 m | unobserved 80% | 0 |
| miley | 11-02 18:44Z | 48.5 h | 4.1 m | present 99% | 0 |
| miley | 11-03 05:12Z | 37.2 h | 3.5 m | present 99% | 0 |
| miley | 11-03 05:12Z | 13.2 h | 0 | present 100% | 0 |
| izzo | 11-03 18:06Z | 24.2 h | 0 | present 100% | 0 |
| izzo | 11-03 18:49Z | 23.5 h | 0.3 m | present 100% | 0 |
| miley | 11-03 20:20Z | 22.0 h | 2.2 m | present 99% | 0 |
| miley | 11-03 20:21Z | 22.0 h | 1.8 m | present 99% | 0 |
| miley | 11-03 20:22Z | 22.0 h | 1.5 m | present 99% | 0 |
| miley | 11-03 20:22Z | 1.6 h | 0 | present 99% | 0 |
| izzo | 11-03 22:35Z | 19.7 h | 0.5 m | present 100% | 0 |

Median free wait **227.6 s**, between the two bounds: **part of it**. Unobserved share of act-lane
waited time **10.1%**, under the 50% that would void the read.

The median sits on the seam between two regimes, and the verdict is their blend:

1. **Seven izzo acts on the evening of 10-29** (01:07Z–04:59Z): free wait 2–2.7 h each, and 124–139 min
   of each is `hourly_cap`. Seven acts arrived in four hours against a cap of two wakes an hour; the cap
   is the lane's own gate, and it held every act in the burst for over two hours.
2. **Eleven acts from 11-02 on:** free wait ≤ 4.1 min, nine of them ≤ 2.2 min, with the seat `present`
   99–100% of the raw wait. When the seat's own session let go, the lane woke it within minutes.

Two waits (miley 10-30 01:38Z, izzo 10-30 04:14Z) are 73–80% `unobserved`: no gate row was in force for
~16 h of each. They are counted, as pre-registered, and their 16 h of free wait sit above the median
without moving it. One izzo act (10-30 04:06Z) was leased in 2 s with no hold at all.

### R7a — raw wait

Act-lane seats: median **59,271 s (16 h 28 m)**, n = 20. Every other seat: **11.7 s**, n = 53. Worse than
finding 029's 2 h 55 m, and for the reason the gate record now shows: the act-lane seats were `present`
for 67% (izzo) and 91% (miley) of all the time their acts waited, i.e. an attended session held the seat
and the wake could not proceed.

### R7b — rate and cost

| Seat | $ by UTC day |
| --- | --- |
| izzo | 10-29: $0.24 · 10-30: $0.00 |
| miley | no priced wake |
| grokbot | no wake |

Kill rule ($10 in a seat-day): no breach.

### Beside the rules — share of waited time per gate

| Seat | present | unobserved | hourly_cap | snoozed | lease_live | passed | reclaimable |
| --- | --- | --- | --- | --- | --- | --- | --- |
| izzo | 67.2% | 12.2% | 11.7% | 3.8% | 3.2% | 1.3% | 0.6% |
| miley | 90.7% | 8.7% | 0 | 0.3% | 0 | 0.1% | 0.3% |

grokbot received no directed act that got a wake lease in the window; it has no row.

## How far it reaches

- R8a's "part of it" is the pre-registered reading and stands. It is not a single effect: the lane woke an
  unattended seat within minutes (11 of 20 waits), and the lane's own cap held a burst for two hours (7 of
  20). Which of those a team sees depends on whether acts arrive in bursts.
- The seats were attended for most of the window, so most of each raw wait was never the lane's to shorten.
  That is the same product gap finding 029 named, now measured: 67–91% of the waited time.
- n = 20 is over the pre-registered floor of 5, but it is two seats and two clusters of acts (one evening,
  one afternoon). grokbot contributes nothing.
- Two waits sit on a 16 h gap in the gate record. 10.1% unobserved is well under the 50% void line, but the
  gap itself is a product finding: the holds table did not cover 10-30 for either seat.

## Product gaps the read hit

1. **The hourly cap is the dominant lane-side hold.** On a burst of seven acts, a cap of two wakes an hour
   turned a 2-minute lane into a 2-hour one. A cap that counts acts rather than wakes, or that batches the
   queued acts into one wake, would remove most of the lane's own share.
2. **A 16 h hole in the gate record on 10-30.** Both seats show ~16 h `unobserved` on their 10-30 waits.
   ADR 753 writes a row when the gate changes; something (a daemon restart, or a seat with no gate
   evaluation while its lease was held elsewhere) left no row in force. Worth a look before the next read
   that depends on the holds table.
3. **Attended sessions still hold the seat** for most of the wait, as in finding 029. The lane cannot help
   with that; only an interrupt into the live session can.

## Decision for nick

The manifest prescribes an outcome for "acted" (keep the lane) and "did not" (retire it); "part of it" is
nick's call. The numbers say: keep the lane if bursts are rare or the cap is changed, since an unattended
seat woke within minutes; retire it if the cap stays at 2 and acts keep arriving in bursts, since then the
lane's own gate costs about as much as the seats' sessions did in finding 029.
