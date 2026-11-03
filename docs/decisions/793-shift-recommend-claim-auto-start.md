# 793 — When a seat on shift runs out of work

- Status: accepted
- Date: 2026-11-03

## Context

ADR 792 puts a seat on shift. On shift it works its claimed lanes, and when it has none it stops
with `no_work`. The design (`docs/superpowers/specs/2026-11-02-seats-on-shift-design.md`, approved
by nick 2026-11-02) asks for more before that stop: the seat recommends open work and waits, at the
team default `autonomy: ask`. At `claim` and `free` it may take work alone. ADR 792 stored
`autonomy` and `shift_start` but acted on neither.

## Problem

A seat on shift that finishes its lanes goes off shift, though the board holds work it could do and
a person would likely pick some for it.

## Decision

1. **At `ask`, the seat recommends once per shift.** When the shift watch (ADR 792) finds an
   on-shift seat with nothing claimed or active, it takes the seat's top three lanes from
   `team_next`'s `up_next` ranking (ADR 536), so the seat's own view and the recommendation agree.
   The daemon raises one ADR 773 question as the seat, to the team: "My claimed lanes are done.
   Which of these should I take next?". Each option is a lane (title, then id). The last option is
   "None, end my shift". The question is audited `shift.recommended {question, lanes,
   shift_started_at}`.
   - While it is open, the seat waits; it is neither stopped nor asked again.
   - An answer naming a lane is a person's verified answer, so it wakes the seat (ADR 774, ADR 790)
     to claim that lane. The watch gives that wake `SHIFT_NO_WORK_GRACE_MS` (15 minutes) before it
     counts the seat as out of work.
   - "None", or a recommendation already made this shift with still nothing claimed, stops the
     shift `no_work`. A new Start allows a new recommendation.
   - With nothing on the board to offer, the shift stops `no_work` at once.
2. **At `claim` and `free`, the seat takes a lane alone.** It takes the top lane in the same
   ranking, by the guarded lane write (open and unowned at the moment of the write). At `claim`
   only a lane on one of the seat's `autonomy_goals` (a new optional policy key, at most 20 goal
   ids) qualifies; at `free` any lane does. A lane with a risk tag is never claimed alone; it is
   only ever recommended. The claim is audited `shift.claimed`. With nothing it may take, it
   recommends as at `ask`.
3. **`shift_start: auto` starts the seat once a day.** The first shift-watch sweep inside an
   enrolled agent seat's working hours starts its shift, `started_by: 'auto'`. Never outside hours,
   never a halted seat, and never on a day that already has a row: a stopped shift stays stopped
   until a person's Start.
4. **CLI.** `musterd residency policy|on … --autonomy-goals <goal,goal>` sets the list.

## Consequences

- A seat on shift ends its day with a question to the team, not with silence. The answer card is
  the same one `/live` and the phone already show.
- The recommendation is posted as the seat, though the daemon composed it. Its audit row
  (`shift.recommended`) is the record of that.
- `autonomy_goals` empty or unset with `autonomy: claim` claims nothing alone; the seat
  recommends.
- Follows-up: lane `01M6H8C6QGRZ7Z3D65AD33SZRE` (the `/live` settings for these knobs, and a Start
  after a `budget` stop asking to raise the budget).

## Observability & Evaluation

- **Traces:** audit `shift.recommended {question, lanes, shift_started_at}`, `shift.claimed
  {lane_id, autonomy, shift_started_at}`, `shift.started {by: 'auto'}`; the question's own ADR 773
  rows.
- **Eval:** `shiftWatch.test.ts` pins one recommendation per shift with its options, waiting while
  it is open, the grace after a picked lane, "none" stopping, an empty board stopping at once,
  `claim` taking only a listed goal's safe lane and `free` any safe lane, and `auto` starting once
  a day inside hours.
- **Experiment:** for two weeks, count recommendations by answer (a lane, none, unanswered by the
  shift's end). **Falsify:** most recommendations unanswered or answered "none", which would mean
  the ranking offers the wrong lanes or the question is noise.
