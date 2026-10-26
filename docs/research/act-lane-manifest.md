# The act lane on revive: pre-registration

**Lanes:** `01M5WRYTMK` (this page), `01M5WS00G1` (ADR 735, the product change), the read → finding
029 (lane opened at the switch); goal `coordination-cost`, asked by nick ("lets build the act lane and
measure it where idle time is real, but remember we dont have that much time to wait around").
**Status:** pre-registered 2026-10-26, before any seat is enrolled on the lane. Nothing below changes
once a seat is on it; what the read teaches goes in the finding, not here. **Before this:** [finding
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
| R7a | median `waited` on act-lane seats' wakes | the launch lanes' median `waited` over the baseline day, all enrolled seats | **≤ 2 min** | **≥ 15 min** |
| R7b | wakes per act-lane seat per day, and $ per wake (median) | the same seats' last 14 days on the launch lanes | report; kill rule only | — |

Between R7a's bounds: "part of it", with the distribution. R7b has no verdict rule: the lane is expected
to wake more often; the question is whether the money stays bounded. **Kill rule:** an act-lane seat
whose priced wakes exceed **$10 in one day** goes back to `--lane both` and the finding says so.
Reported beside them, no rule: the share of act-lane wakes whose act was a plain `message` (the kind the
launch lanes never wake on), failed wakes, and the per-wake cost on the launch lanes over the same days.

## Procedure

1. ADR 735 lands on `main`; the auto-refresher carries it to the hub daemon and the host loops.
2. **Baseline day (24 h):** no enrollment changes. Every wake's `waited` is now on the host line.
3. **The switch:** nick, from his own Workspace (ADR 442), enrolls two or three agent seats on the act
   lane — proposed, by directed acts received while offline over the 14 days: `izzo` and `miley`
   (claude-code, mac.lan), and `grokbot` (grok, mac.lan) — `musterd residency on --seat <s> --workspace
   <its folder> --lane act`. The hourly cap stays at the team default (2) unless nick raises it; if he
   does, the manifest's finding records the value.
4. **48 h on the lane.** The kill rule is checked at the day boundary.
5. **Read once**, write finding 029, and leave the seats on the lane or not as nick decides.

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
| Window: 24 h baseline + 48 h on the lane | this manifest, from "not much time to wait around" |
| Finding number | 029 |
