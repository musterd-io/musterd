# 617 — A companion gesture beside the slot's beat, and the room notices (amends ADR 086)

- Status: accepted
- Date: 2026-10-15
- Amends: [ADR 086](086-ambient-office-life.md) (its performance budget's "at most one beat at a time")

## Context

ADR 086 gave the office ambient life in two tiers. Tier A is CSS on the compositor, and Tier B is
rare, brief canvas beats. Its performance budget says "at most one beat at a time". The E1 scheduler
(`ambientSeed.ts`) carries that out on a shared 10-second lattice: each slot rolls once, seeded by
team and slot, and picks the dog, a desk-pair chat, an aisle meet, or one member's beat. Every viewer
sees the same room.

The office-liveliness spec (2026-10-13, L1) set the bar that every seated member makes a noticeable
move within ten minutes. Lane `01M4V9VNMY` made the single-member pick a fair rotation, but the
rotation runs out of turns. A playing beat holds the room "busy", so a 12-person room delivers about
ten single-member beats in ten minutes. A uniform draw left 35% of that room still; the rotation took
it under 20%, and the spec recorded the original bar as unreachable without changing ADR 086.
On 2026-10-15 nick chose to change it and keep the bar.

## Problem

In a room of twelve, several seated people never move between beats for ten minutes or more, and on
a stream that reads as a frozen desk. Raising the fire rate does not help, because self-contention,
not the roll, is the ceiling (measured 2026-08-25, `AMBIENT_P_FULL`). Cutting the dog's share does
not reach twelve either.

## Decision

1. **A companion rides along, weighted toward moments worth watching.** In a room of
   `COMPANION_MIN_ROOM` (6) or more seated members, a fired slot may carry one companion. The seeded
   probability is `COMPANION_P_MOVING` (0.9) when the slot's beat moves (the dog, an aisle meet) and
   `COMPANION_P_STILL` (0.4) when it does not (a member's beat, a desk chat). The companion is another
   seated member who plays an **in-place** beat: a seated gesture, a sip, a swivel, or the notice in
   decision 4. It is never a walk or an errand. nick chose this split over a flat 0.75 or 0.5 ("is
   there a middle ground?"). It keeps 0.75's coverage with about 10% fewer seated beats, and puts 65%
   of companions beside a mover rather than 46%.
2. **Turns are shared, and pure.** The companion takes the next turn of the same rotation as member
   beats, skipping the beat's own actors. A skipped member keeps the following turn rather than
   losing it. Turns are a replay of the coverage window's earlier slots, so two viewers land on the
   same members and nobody stores anything.
3. **A companion never starts a wake.** It plays only beside a beat that played in this browser, so
   it shares a Tier-B wake the room was already paying for. ADR 086's other limits stand: at most
   about 4 s, at most 20 fps, preempted by any real act, and nothing under reduced motion.
4. **The room notices.** When the slot's beat is moving within `NOTICE_RANGE` (280 floor units) of
   the companion, the companion swivels in the chair to watch it go by instead of gesturing. Moving
   beats are the dog walking to a nap spot, an aisle meet, or a colleague's errand. The companion
   holds for about 1.5–2 s, plays a small reaction (chin, glance, or lean back), and turns back to the
   desk (`actors.notice`, built on the desk chat's seated turn). Which member notices is shared; the
   exact facing follows where the mover is in this browser. If the member can't turn, the companion
   falls back to a gesture.
5. **The bar, restated honestly.** The test bar is ≤ 0.5% of members and ≤ 5% of windows still for
   ten minutes, in a twelve-person room, across 200 seeded teams, under the room-quiet model. It is
   not zero, by construction: a turn spent on a slot that a given browser did not play cannot be
   known to a pure replay. Requiring zero would mean per-browser state choosing who moves, which is
   what E1 exists to prevent.

## Consequences

- In the model, a twelve-person room leaves 0.25% of members still for ten minutes, and about one
  window in thirty-three has one person still; before this, the rotation alone left under 20%. Rooms
  of five or fewer are unchanged.
- The room reads as people sharing a space: a neighbour looks up as the dog pads past, or as two
  colleagues meet in the aisle.
- `AmbientDecision` gains an optional `companion`. The in-page ambient log gains a `companion` kind,
  and `scripts/perf/ambient-density.mjs` keys entries by slot and kind so a companion no longer
  overwrites its slot's beat. The script also reports `membersMoved` and main-thread `busyPct`.
- `/office-preview?n=` accepts more than the hand-written roster: up to eight synthetic working
  colleagues are added, so a twelve-seat room can be measured. Before this, `?n=12` seated only six.
- ADR 086's budget line carries a dated marker pointing here; its Decision is unchanged.

## Observability & Evaluation

- **Traces:** n/a — no agent-facing behaviour; this is a rendering schedule on the web client.
- **Eval:** `ambientSeed.test.ts` sweeps 200 teams of twelve under the room-quiet model and holds the
  bar in decision 5. It also checks that a companion is never the beat's actor, that small rooms get
  none, and that the companion rate stays within bounds. `actors.test.ts` covers `notice`: the member
  turns, stays seated, returns to the desk, and declines when busy. `scene-loop.test.ts` pins that a
  companion only rides a played beat.
- **Experiment:** measured 2026-10-15 on `/office-preview?quiet&n=16` (twelve seated; the hand-written
  roster seats only six, so `?n` now adds synthetic colleagues), with `scripts/perf/ambient-density.mjs`,
  8 minutes per arm, headless Chrome on this laptop:

  | arm | members moved | seated beats/min | main-thread busy (one core) |
  | --- | --- | --- | --- |
  | before (`COMPANION_P_*` = 0) | 12/12 | 4.0 | 22.1% |
  | flat 0.75 (not shipped) | 12/12 | 7.5 | 18.3% |
  | shipped 0.9 / 0.4 | 12/12 | 4.4 | 14.5% |

  The busy numbers move ±4 points from run to run with no change in code, so the companion's CPU cost
  is inside that noise, as decision 3 expects. In this quiet fixture "before" already reached all
  twelve. Beats land at about 3 a minute there, against the model's 1 a minute, which assumes a room
  that real acts keep busy. That busier case is where the companion closes the gap, and the 200-team
  model holds it. Falsifier: `ambient-density.mjs` on
  `/office-preview?quiet&n=16` (twelve seated) over eight minutes reports `membersMoved` under 11, or
  `busyPct` more than 2 points above the same run with `COMPANION_P = 0`.
