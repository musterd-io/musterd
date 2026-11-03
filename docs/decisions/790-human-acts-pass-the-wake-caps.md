# 790 — Human acts pass the wake caps

- Status: accepted
- Date: 2026-11-03

## Context

ADR 131 bounds how often the daemon wakes a seat. Two rate gates do it: `hourly_cap` (wakes in the
last hour) and `cooldown_ms` (time since the last wake). Both are seat-wide. When either holds, the
seat is skipped before any candidate is read, so it does not matter who sent the act that is due.

The gates exist for machine-to-machine traffic: two agents that answer each other can wake each
other without end, and each wake costs money. A person does not do that. A person sends an act
because they want the seat to do something now.

On 2026-11-03 the seats-ask end-to-end check (lane `01M67EBYQ1`) showed the cost of the seat-wide
gate. ryder asked nick two questions with `team_question` and ended its turn (ADR 773). nick answered
both from `/live`. The first answer woke ryder in 58 s. The second answer never woke it: ryder had
used its 2 wakes for that hour, and the verified answer (ADR 774) waited behind the cap. "Start
everyone" (ADR 779) has the same defect: it reports `capped` for a seat at its cap and does not
start it, although a person pressed the button.

The seats-on-shift design (`docs/superpowers/specs/2026-11-02-seats-on-shift-design.md`, approved by
nick 2026-11-02) names this as increment 1, to ship before any shift machinery.

## Problem

The rate gates cannot tell an act a person sent from an act an agent sent. So a person's answer, a
quick action or a steer can wait up to an hour behind wakes that agents caused.

## Decision

1. **The rate gates filter candidates, not seats.** The daemon reads the seat's due candidates
   whether or not the seat is at `hourly_cap` or inside `cooldown_ms`. Then it drops each candidate
   that the gates hold.
2. **A human-sent candidate passes both rate gates.** A candidate passes `hourly_cap` and
   `cooldown_ms` when its act's sending Member (read by member id from the act's row, never by
   name) has `kind = 'human'` on this team. This includes a verified answer (ADR 774), a quick
   action (ADR 779), and a steer, ask, request_help, handoff or message that a person sent. An act
   sent from a wake or dream session (`from_provenance` `wake` or `dream`) never passes, whoever's
   seat it is: a human seat can be enrolled for wakes, and a machine chain must not borrow the
   pass.
3. **All other gates still bind a human-sent candidate.** These are the halt (ADR 501), live
   presence, a live lease, the deferral snooze, `attempt_cap`, ADR 434's spent-act rule, and the
   spend gates (ADR 611, ADR 636, ADR 641). A human act to a halted seat does not wake it. A human
   act to a seat over the team spend cap is held, not leased.
4. **Nothing changes for other senders.** A candidate from an agent or service seat, and a work
   order or dream (which have no sender), is held by the rate gates as before.
5. **The lease says when it used the pass.** The `residency.wake_leased` audit row gains
   `human_pass: true` when the seat was at its cap or inside its cooldown and the human sender is
   the only reason the lease was minted.
6. **"Start everyone" no longer reports `capped`.** A Start is a person's steer, so decision 2
   covers it. The result for each seat is `started` or `offline`.

## Consequences

- A person's act wakes the seat on the next poll, whatever the seat's recent wake count.
- A person can cause more wakes than `hourly_cap` allows. That is the intent: the cap is for loops,
  and a person is not a loop. The spend gates still bound the cost.
- The gate state that ADR 753 records is decided after the filter. A seat whose only due candidate is
  human-sent records `passed`, not `hourly_cap`.
- Dreams (ADR 494) still need a cooled seat that is under its cap.
- Tests that used a human sender to pin the cap or the cooldown now use an agent sender. The human
  case is pinned by new tests.
- The seats-on-shift increments (lanes `01M6H8BPVD`, `01M6H8C17E`, `01M6H8C6QG`) build on this
  filter. Follows-up: lane `01M6H8BPVDT88VGYP24750EZJP`.

## Observability & Evaluation

- **Traces:** `residency.wake_leased` carries `human_pass: true` on a lease the rate gates would have
  refused. The ADR 753 gate row records the gate that held the seat after the filter.
- **Eval:** `residency.test.ts` pins that a verified answer and a human steer pass the cap and the
  cooldown, that an agent message does not, that a halted seat and a seat over the spend cap stay
  held, that an act sent from a wake or dream session gets no pass, and that the lease row carries
  `human_pass`. `quickActions.test.ts` pins that Start everyone
  returns `started` for a seat at its cap.
- **Experiment:** count `wake_leased` rows with `human_pass` per seat per day for a week, beside the
  ADR 779 wake count by cause. **Falsify:** a seat that gets more than 10 `human_pass` leases in a
  day, which would mean a human act is reaching a seat in a loop (for example, an automation that
  posts as a human Member).
