# 735 — The act lane: an enrolled seat ends its turn, and the next directed act resumes it

- Status: accepted
- Date: 2026-10-26
- Lane: `01M5WS00G1` (goal `coordination-cost`), asked for by nick ("lets build the act lane and
  measure it where idle time is real, but remember we dont have that much time to wait around")
- Amends: [131](131-harness-residency-wake-ledger-host.md) §3 (a third wake lane); the
  `ResidencyPolicySchema` lane enum and `hourly_cap` range; `WakeOrder` gains `act_ts`
- Extends: [434](434-a-discharged-act-never-re-wakes-its-seat.md) (its discharge rule bounds the lane),
  [252](252-wake-cost-failure-path.md) (every wake on this lane is priced like any other)

## Context

Six CooperBench riders (findings 022 to 028) moved what musterd says to a seat: the refusal, the freed
act, the push act, the pusher's line, what changed. The last of them,
[finding 028](../research/028-cooperbench-rider6-run.md), read the one rule aimed at the money and found
it unmoved: `team_inbox_check` calls in wait mode went from 82 to 90 while every push was announced.
The read beside the rule said why. Of 98 wait calls, 94 returned an act. Sixteen returned the push act
itself and 25 found it already in the inbox. The waits were not idle polls an act could replace. On a
two-seat task the agents take turns by message, and a wait is how a seat ends its turn and hears the
next one. Every incoming act costs the receiver a turn to read and a turn to answer, whoever wrote it.
The cost is the loop, not the message.

musterd already owns the other loop. Harness residency (ADR 131) lets an enrolled seat go offline; a
directed act makes a wake due; `musterd host` resumes the session with the act in a wake packet,
verifies it on the roster and prices it. It was built for the seat that is away — overnight hand-offs —
and tuned for it: the batched lane waits a cooldown of at least a minute and defaults to thirty, two
wakes an hour, and reads only `request_help`, `handoff` and urgent acts (the ADR 090 ledger). A plain
`message` to a sleeping seat is a note on a desk ([which acts wake a
seat](../wiki/which-acts-wake-a-seat.md)). The immediate lane fires for `steer` and urgent only.

So the inverted loop exists and is one knob away from being usable as the way a seat runs, not only
the way it is recovered. What is missing is a lane with no cooldown that reads every directed act, a
sentence of guidance that tells such a seat to stop waiting, and a number: how long an act waited for
its wake, readable without the daemon's admin-only audit. On this machine's host log the last 14 days
hold 2,050 due wakes, 109 of them priced: median $0.21, mean $0.55 a wake.

## Problem

Let a seat run the inverted loop today, on the residency machinery that exists, with the rate bounds
that already protect the team's money, and make the one quantity that lane exists to shorten — the time
a directed act waits for its seat — visible on the host that pays for it. Do it without touching the
CooperBench arm: its agent prompt is frozen for comparability, and this change is measured where idle
time is real, on the team.

## Decision

1. **A third wake lane, `act`.** `ResidencyPolicySchema.lane` gains `'act'`. For a seat on it the
   derivation waives the cooldown (`cooled` is true by policy, not by the ledger) and adds a candidate
   source: every directed act to the seat from another member that the seat has not read — newer than
   its inbox cursor, any act kind, a plain `message` included (`listDirectedSince`, receipt order, 200
   at most). The candidates ride the batched lane (`lane: 'batched'`, `derivation: 'batched'`): the
   lease, the report, the ledger and the roster need no new value. Everything that bounds a wake still
   bounds these: the hourly cap and the attempt cap (§2), ADR 434 §2's spent-act skip, ADR 211 §4's
   deferral suppression, ADR 494 §4's dream rule, ADR 463's host scope, the live-presence and lease
   guards. `both`, `interrupt` and `batched` are unchanged; the team default stays `both`.
2. **The hourly cap reaches 60.** `hourly_cap`'s range widens from 20 to 60 so a per-seat override may
   let an act-lane seat be resumed once a minute at most. The default stays 2, which means an act-lane
   seat enrolled without an override wakes at most twice an hour — the same money as today, sooner.
3. **The order and the host line carry the wait.** `WakeOrder` gains optional `act_ts`, the triggering
   act's send time, set for every inbox candidate on every lane (the immediate and batched sources
   already knew it for ADR 210). The host's `wake due` line becomes `wake due: <seat> [<lane>] — <act>
   from <sender>, waited 7m12s (lease …)` (`waitedClause`; nothing when the order names no act time).
   The act lane's measurement is therefore in `~/.musterd/host.log` on the machine that ran the wake,
   for every lane, with no admin read.
4. **Guidance says it once.** The "Waiting without polling" section gains: a seat enrolled on the act
   lane does not wait at all — when you have nothing to do, end your turn; the host resumes you on the
   next directed act, and the wake carries it. `GUIDANCE_CONTENT_VERSION` 59 → 60, pinned.
5. **Nothing else changes.** No new act, no new route, no change to what a wake runs or how it is
   verified, priced or reported. The CooperBench arm's instructions are untouched; the arm is not a
   subject of this ADR.

### Rejected

- **A new `WakeLane` value on the wire.** The lease, the roster badge, `/live` and the report all read
  the two launch lanes; an act-lane wake is a batched wake that did not wait. The policy knob names the
  behaviour; the lane on the order names what the host does, which is the same.
- **Removing the cooldown floor instead of a lane.** `cooldown_ms: 0` would silently change the
  batched lane's meaning for every enrollment that sets it low, and the ADR 090 ledger would still
  leave a `message` inert. The lane is a choice a human makes at enrollment, and it reads more acts.
- **Waiving the hourly cap on the act lane.** Finding 028's agents received an act about every minute.
  A seat woken at that rate at $0.21 to $0.55 a wake is the cost ADR 252 exists to make visible, not
  to remove. The cap stays, and its range is the only thing that widens.
- **Measuring on CooperBench.** The arm's prompt tells its agents how to wait; changing that sentence
  ends the comparability of seven findings, and on a 25-minute two-agent task the wake overhead could
  equal the wait cost it replaces. The read is on the team, where idle is hours and the wait is real.

## Consequences

- An admin may enroll a seat with `musterd residency on --seat <agent> --workspace <its folder> --lane
  act [--hourly-cap <n>]` from their own Workspace (ADR 442). Nothing changes for any seat not so
  enrolled.
- On the act lane a plain `message` wakes the seat. The wiki's "note on a desk" holds for the two
  launch lanes and says so.
- Two protocol changes under this ADR (hard rule 1): the lane enum and cap range on
  `ResidencyPolicySchema`, and `act_ts` on `WakeOrder`. An older host ignores the field; an older daemon
  omits it and the host prints the line as before.
- One more read per act-lane seat per poll (its directed acts since the cursor). None for other seats.
- The pre-registered read is lane `01M5WRYTMK` ([act-lane manifest](../research/act-lane-manifest.md)):
  a day of `waited` on the launch lanes as the baseline, then two days with two or three agent seats on
  the act lane. Finding 029.

## Observability & Evaluation

- **Traces.** The host log's `wake due … waited <t>` line per wake (new); `wake cost recorded` per wake
  (ADR 252); the daemon's `residency.woke` / `wake_failed` audit rows as before, with the lease's lane
  `batched`. The policy that made it due is on the enrollment row, read by `residency status`.
- **Eval.** Server test (`residency.test.ts`): on the act lane a plain `message` inside the cooldown
  wakes the seat and the order carries `act_ts`; the same message on the launch lanes wakes nothing; the
  hourly cap still holds at the cap. Protocol tests: `lane: act` parses, `hourly_cap` 60 parses and 61
  does not, the default stays 2; the guidance snapshot at version 60. CLI test: `waitedClause` in
  seconds, minutes and hours, and empty with no act time.
- **Experiment.** The [act-lane manifest](../research/act-lane-manifest.md), pre-registered the same day
  before any seat was enrolled on the lane: R7a median act→wake wait on act-lane seats against the
  batched baseline; R7b wakes per act-lane seat per day and dollars per wake, with a kill rule.
