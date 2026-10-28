# The act lane on revive: pre-registration

**Lanes:** `01M5WRYTMK` (this page), `01M5WS00G1` (ADR 735, the product change), the read → finding
029 (lane opened at the switch); goal `coordination-cost`, asked by nick ("lets build the act lane and
measure it where idle time is real, but remember we dont have that much time to wait around").
**Status:** pre-registered 2026-10-26, before any seat is enrolled on the lane. _(Amended 2026-10-26
19:35Z, before the first act-lane wake: nick enrolled `izzo` on the lane at once instead of after the
baseline day — "we dont have that much time to wait around" — so the baseline is concurrent, not
prior; see the amended Procedure and R7a. No act-lane wake had happened when this was written; the
amendment is a design change, not a reading.)_ _(Amended 2026-10-28, after finding 029: the
[re-read](#re-read-on-the-adr-753-build) on the ADR 753 build, pre-registered before its window opens.)_ Nothing below changes once an act-lane wake has
happened; what the read teaches goes in the finding, not here. **Before this:** [finding
028](./028-cooperbench-rider6-run.md), whose R6b said the wait call is the cost and the loop is the lever.

## Why

Finding 028: on CooperBench, 94 of 98 wait-mode inbox checks returned an act. The waits were the seats'
turn boundaries, not idle polls, so no change to what an act says can remove them. musterd's residency
already runs the other loop — an offline seat is resumed by `musterd host` when a directed act lands —
but it was built for the seat that is away: a 30-minute cooldown, two wakes an hour, and only
`request_help`, `handoff` and urgent acts wake it; a plain `message` is a note on a desk.
[ADR 735](../decisions/735-act-lane-the-seat-ends-its-turn.md) adds the `act` lane: every unread
directed act wakes the seat, no cooldown, the caps unchanged; the host's `wake due` line gains `waited
<t>`, the act's wait for its wake. The CooperBench arm is not the instrument (its agents' prompt is frozen
and its idle is seconds); the revive team is, where a seat is offline for hours and a directed act to it
waits.

**What this machine's host log says before the change** (`~/.musterd/host.log` on mac.lan, 14 days to
2026-10-26, read once): 2,050 `wake due` lines, 2,039 batched and 11 immediate; by act,
`request_help` 740, `handoff` 641, `work_order` 602, `ask` 62, `steer` 5; 109 priced wakes, median
**$0.21**, mean **$0.55**, $60.42 in all; 142 `wake FAILED` lines. No line says how long the act waited
— that is what ADR 735 §3 adds, and why the baseline below is read after it lands, not from this history.

## Question

On the revive team, with two or three agent seats enrolled on the act lane and the rest on the launch
lanes, does a directed act reach its seat sooner — and at what rate and cost of wakes?

**This read makes no claim about CooperBench, pass rates, or the hosted seat.**

## Reads

All from the host logs on the machines that run the wakes (`~/.musterd/host.log` on mac.lan and
Nicks-Laptop.local), the `wake due … waited <t>` and `wake cost recorded` lines, read once by a short
`actlane.py` written before the switch and copied into the finding's folder. A wake is attributed to a
seat by the line's seat name; its lane by the enrollment row (`musterd residency status --json`) at the
time, not by the line's `[batched]`.

| | Count | Baseline | Acted | Did not |
| --- | --- | --- | --- | --- |
| R7a | median `waited` on act-lane seats' wakes | the launch-lane seats' median `waited` over the **same 48 h** (concurrent, amended 2026-10-26; the originally registered prior baseline day was dropped at the switch), plus any launch-lane `waited` lines before each seat's switch | **≤ 2 min** | **≥ 15 min** |
| R7b | wakes per act-lane seat per day, and $ per wake (median) | the same seats' last 14 days on the launch lanes | report; kill rule only | — |

Between R7a's bounds: "part of it", with the distribution. R7b has no verdict rule: the lane is expected
to wake more often; the question is whether the money stays bounded. **Kill rule:** an act-lane seat
whose priced wakes exceed **$10 in one day** goes back to `--lane both` and the finding says so.
Reported beside them, no rule: the share of act-lane wakes whose act was a plain `message` (the kind the
launch lanes never wake on), failed wakes, and the per-wake cost on the launch lanes over the same days.

## Procedure

1. ADR 735 lands on `main` (#3346, `9eeaebd8`, 2026-10-26 19:13Z); the auto-refresher carries it to the
   hub daemon and the host loops (this machine's host restarted on it at 19:13Z).
2. ~~**Baseline day (24 h):** no enrollment changes.~~ _Amended 2026-10-26: dropped at the switch. The
   baseline is the launch-lane seats over the same 48 h (R7a), and every wake's `waited` is on the host
   line from step 1 on, whichever lane._
3. **The switch:** nick, from his own Workspace (ADR 442), enrolls two or three agent seats on the act
   lane — proposed, by directed acts received while offline over the 14 days: `izzo` and `miley`
   (claude-code, mac.lan), and `grokbot` (grok, mac.lan) — `musterd residency on --seat <s> --workspace
   <its folder> --lane act`. The hourly cap stays at the team default (2) unless nick raises it; if he
   does, the manifest's finding records the value. _Done for `izzo` at 2026-10-26 ~19:33Z from nick's
   Workspace on his Mac (`/Users/nick/musterd/revive/agents/izzo`); the re-enrollment recorded the
   harness as **codex** (the row had said claude-code), overrides `{"lane":"act"}`, and noted a live
   session that keeps its old grant until its next wake. `miley` and `grokbot` followed by ~19:40Z, same
   machine, same flag — all three proposed seats are on the lane; hourly cap at the team default (2)._
4. **48 h on the lane**, counted from the first seat's switch. The kill rule is checked at the day
   boundary.
5. **Read once**, write finding 029, and leave the seats on the lane or not as nick decides.

## Re-read on the ADR 753 build

_Amended 2026-10-28, after [finding 029](./029-act-lane-read.md) and before this window opens; lane
`01M62BJWMQ`, asked by nick._ Finding 029 missed R7a, at a median of 175.5 min over 6 waits, but could
not say what held the acts. [ADR 753](../decisions/753-wake-holds-on-the-report.md) (#3483) now records
which daemon gate held each enrolled seat (`present`, `reclaimable`, `lease_live`, `snoozed`,
`hourly_cap`, `cooldown`, or `passed`) and splits each wait by it on the report. The seats, their lane
and the hourly cap are unchanged: izzo, miley and grokbot, `--lane act`, cap 2, on mac.lan.

- **Window:** acts sent 2026-10-29T00:00Z → 2026-11-04T00:00Z (6 days). Read once between 2026-11-04
  00:00Z and 2026-11-05 00:00Z, while the report's 7-day window still covers the whole window.
- **Source:** one `musterd report residency --json`, read by
  [`reread.py`](./act-lane/2026-10-29-reread/reread.py), written with this amendment. No host log.
  An act counts when its ts is in the window and it got a wake lease. An act never leased is not in
  the report, as in finding 029.

| | Measure | Acted | Did not |
| --- | --- | --- | --- |
| **R8a** (primary) | median **free wait** on act-lane seats: the wait minus the time the seat was `present`, `snoozed`, `reclaimable` or `lease_live`, i.e. held by its own session or an in-flight wake, not by the lane | **≤ 2 min** | **≥ 15 min** |
| R7a | median raw wait, act-lane seats vs every other seat | report | — |
| R7b | act-lane $ per seat per UTC day; the $10 kill rule as above | report; kill rule | — |

Between R8a's bounds: "part of it". **Fewer than 5 act-lane waits:** inconclusive. **Invalid:** if
more than half of the act-lane seats' waited time is `unobserved` (no gate row in force), the gate
record did not cover the window, and R8a is not read as a verdict. On the 7 days before this amendment,
which predate ADR 753, the script returns exactly that (98.8% unobserved). Reported beside them: each
act-lane seat's share of waited time per gate state.

**What follows the read.** If R8a did not act, the finding recommends taking the three seats off the
act lane and retiring it: the lane does not shorten a wait even when nothing else holds the seat. If it
acted, the slowness in finding 029 was the seats' own sessions, and the lane stays. nick decides either
way. The finding is 030.

## Spend

Wakes are model spend on the seats' own keys: at the 14-day rates, two to three seats at the team's cap
of two wakes an hour cost at most about $26 a day each at the mean price, and in practice far less,
since a wake is due only when an act waits. The kill rule bounds a runaway seat at $10 a day. No
CooperBench spend.

## Decisions

| Decision | Answer |
| --- | --- |
| Build the act lane; measure on the team, not CooperBench | nick, 2026-10-26, in session |
| Seats on the lane and the hourly cap | nick, at the switch (step 3); this page proposes three |
| Window: ~~24 h baseline +~~ 48 h on the lane with a concurrent launch-lane baseline | this manifest; amended at the switch 2026-10-26 on nick's enrolling izzo at once |
| Finding number | 029 |
| Re-read on the ADR 753 build: R8a free wait, 6 days, finding 030 | nick, 2026-10-28, in session ("go ahead with the manifest amendment") |
