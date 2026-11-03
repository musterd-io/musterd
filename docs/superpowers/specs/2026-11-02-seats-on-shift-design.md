# Seats on shift — design

- Date: 2026-11-02
- Lane: `01M6FY99PH`, goal `cloud-agents`
- Brainstormed with nick; written by fifty. The parts marked **fifty's call** are mine; the rest is
  what nick said.

## Why

nick is moving the hub and most seats off his laptop: the Linux joiner (`musterd-joiner-1`) today,
hosted musterd Cloud next. Before that move he set one condition: **he must be able to drive, steer
and use seats from `/live` or the CLI the same way he does from a harness session on his laptop.**

The seats-ask work got most of the way there: a seat's question becomes a card he answers anywhere,
and the four quick actions (Start, Check inbox, Check PR, Resume as typed) reach a seat without a
terminal (ADR 773, 774, 779). The end-to-end check on 2026-11-02 (lane `01M67EBYQ1`) then found the
wall: **the wake rate gates.** ryder on the joiner asked, nick answered on `/live`, ryder resumed in
58 s; ryder asked again, nick answered within a minute, and nothing happened. The seat had spent its
two wakes for the hour (ADR 131 launch defaults: 30-minute cooldown, 2 wakes/hour/seat), and the
hourly-cap gate runs before the daemon looks at what is due, so an answer to the seat's own question
is rationed like any machine-to-machine act (`residency.ts`, `gate('hourly_cap')`).

Those defaults were set for the case they fit: a seat nobody is watching, woken by other agents
overnight, where the worry is runaway spend. They are the wrong instrument for a seat a person is
driving. When nick answers a question or presses Start he *is* the budget authority in that moment;
rate-limiting him is a terminal that refuses the third prompt of the hour. And the rationed model
has no notion of "keep working on what you have" at all: a seat that finished one wake goes quiet
until someone sends it something.

## What it is

**Start puts a seat on shift. On shift, a seat behaves like one nick opened in a terminal and told
to get on with it, within guardrails he set once.**

nick's morning, in his words: go to `/live`, read what members have recently been working on and
where things stand, then individually Start seats, greet them so they orient, and take the tier-1
asks that come back. From there each seat should:

1. **Work its own claimed lanes** — anything it already owns and has not finished — without being
   prodded.
2. **Answer anything directed at it** — asks, questions, reviews, handoffs, acceptance requests.
3. **Do all the normal musterd acts** — messages, status, approval requests, submits, reviews.
4. **Recommend, not grab.** When its claimed work runs out, it recommends unowned items already on
   the board and waits for an answer. It does not claim on its own (the team default; see levels).
5. **Not work indefinitely.** It stops on guardrails nick set: working hours, a daily budget, or
   nothing left to do. When it stops it says so, like it says anything else.

The guardrails — hours, budget, how a shift starts, how much the seat may take on alone — are
**configurable by the user**, with team defaults and per-seat overrides. The same shift state is
visible and settable on `/live`, the CLI and MCP where it makes sense.

### The shift model

A seat is in one of two states with respect to wakes:

| State         | Who wakes it                                              | What bounds it                                   |
| ------------- | --------------------------------------------------------- | ------------------------------------------------ |
| **on shift**  | itself (claimed work, directed acts), and any human       | working hours, daily budget, attempt cap, spend gates |
| **off shift** | other agents and the board, rationed as today (ADR 131)   | cooldown, hourly cap, attempt cap, spend gates   |

**On shift** the seat keeps itself going: when a turn ends and there is claimed work or an unread
directed act, the daemon issues the next wake without a cooldown and without counting an hourly cap.
The existing ADR 735 `act` lane is the nearest thing today (every open directed act is due, no
cooldown) and is the mechanism a shift wake rides; what a shift adds is the *claimed-work* reason
("you own lane X and it is not done") and the *recommendation* reason ("your claimed work is done;
here is what is open"), both daemon-composed lines like the quick actions (ADR 779).

**Off shift** nothing changes from today, with one exception that stands on its own (below).

### Human acts always wake, on or off shift

Anything a person does to a seat wakes it without being counted against the cooldown or the hourly
cap: a verified answer to its question (ADR 774), a quick action (ADR 779), a steer, an ask, a
request_help, a message addressed to it. The attempt cap still binds (a seat that dies three times
on one act still stops), and the spend gates still bind (ADR 611/636: a seat over the team's cap is
held whoever woke it). This is the fix for the check's finding and is the first increment, before
any shift machinery, so that answering a seat's question works tonight.

### Shift settings

Per seat, with a team default, in the same shape as the residency policy today (team `policy`
defaults, a sparse per-seat override, `musterd residency policy` and `--seat` to set them):

| Setting      | Meaning                                                                 | Team default (nick's) |
| ------------ | ----------------------------------------------------------------------- | --------------------- |
| `hours`      | working hours, in the team's timezone; outside them the seat is off shift | 09:00–18:00 Mon–Fri, team tz (nick, 2026-11-03) |
| `budget_usd` | the day's spend; reached, the seat goes off shift until tomorrow          | $10 per seat per day (nick, 2026-11-03)         |
| `start`      | `manual`: on shift only on Start · `auto`: on shift when hours open       | `manual`              |
| `autonomy`   | `ask` · `claim` · `free` (below)                                          | `ask`                 |

**Start** (the quick action, per seat or Start everyone) puts a seat on shift now, whatever the
clock says: it is how nick pulls a seat in early, on a day off, or after a stop. A shift started by
hand still ends on the same guardrails. **fifty's call:** a manual Start outside hours runs until the
day's budget or the work runs out, not until "hours end" (they already have); a manual Start inside
hours ends when hours end. The budget is never unset: a seat with no override has the team's $10,
and a team with no setting has $10, so a Start at 20:00 with claimed work ends when that is spent,
not at sunrise. The day is the team's calendar day in its timezone. A Start after a `budget` stop
does not run: it asks nick to raise the day's budget (a question card) and runs only on his answer.
Every priced wake counts against the budget; an unpriced wake (no cost reported) counts as the
seat's median priced wake of the last 7 days, or $0.50 with no history. **fifty's call** on the
last two.

**Autonomy levels:**

- **ask** — works claimed lanes; when they run out, recommends unowned items and waits. Never claims
  alone. Team default.
- **claim** — may claim unowned lanes on goals a human named for it (the seat's `goal_id` allowlist),
  and recommends the rest.
- **free** — claims any open lane within hours and budget.

The levels only govern *taking on* work. Answering what is directed at the seat and doing the normal
acts is the same at every level.

**Working hours** are the team's existing `working_hours` (ADR 206: a weekly window with its own
IANA timezone, per team with a per-member override), which dreams (ADR 494) and quiet hours already
read. A shift reuses it, not a new field: a seat dreams when off shift and works when on, from one
schedule. nick changes revive's window from 11:00–15:00 to 09:00–18:00 Mon–Fri Pacific with the
first increment (nick, 2026-11-03). This is the first enforcement of the schedule musterd stores
today (ROADMAP: "Schedule & lifecycle enforcement — stored, not enforced"). `availability`
(away/dnd, ADR 044) stays what a human sets about themselves and is not touched.

### What counts as claimed work, and what does not re-wake (fifty's calls)

- **Claimed and not done** is a lane the seat owns in state `claimed` or `active`. `blocked`,
  `parked`, `awaiting_acceptance` and `ready_for_review` are not work for the owner, and a lane whose
  PR is open and waiting on CI or review is treated as `ready_for_review`.
- **A seat waiting on its own question is not re-woken** for claimed work until the question is
  answered (the answer is a human act and wakes it anyway).
- **The ADR 199/306/628 guards stay:** a claimed-work wake that moves nothing
  (`laneMovedSinceLastWoke` false) is not repeated for that lane until something else changes, the
  continuation cap bounds a run of them, and a seat the owner is engaged with is not interrupted.
- **Only human acts and claimed work pass the caps.** An act from another agent to an on-shift seat
  still rides ADR 131's lanes and counts against its caps (anti-goal 4: machine-to-machine chains stay
  rationed). It is read on the seat's next shift wake, which is at most a cooldown away.
- **No work** means nothing claimed-and-not-done, and at `ask` a recommendation already asked and
  unanswered, or nothing to recommend. A seat whose every lane is blocked has no work and says so
  with the lanes named. Any human act after a stop wakes the seat once under the off-shift rules;
  Start puts it back on shift, and so does an answer to its recommendation.
- **A stop lets the running wake finish.** There is no lease cancel today, and a work wake may run
  30 minutes. Stop, hours end and budget prevent the *next* wake; while a wake is still running the
  seat shows **ending** (`/live`, CLI, MCP alike), and the stop line is posted when the lease ends.
  A seat told to stop mid-wake is told so in its next tool result, like a steer (ADR 779's line), so
  it can wrap up.

### What the seat sees

A shift wake's composed line says why it was woken and what bounds it, in the ADR 779 shape:

- claimed work: *"You are on shift until 18:00 (budget $4.10 left). Your lane `01M…` "…title…" is
  claimed and not done — continue it. Check your inbox first."*
- recommendation: *"Your claimed lanes are done. Three open items match your role: … Ask nick which
  to take (team_question), then end your turn."* — at `ask`. At `claim`/`free` the line says to
  claim one and go.
- stop: no wake. The daemon writes the stop reason (`hours_end` / `budget` / `no_work` / `stopped`)
  on the seat's shift row and posts one status line from the board seat (ADR 649): *"ryder is off
  shift: hours ended at 18:00; 2 lanes still claimed."*

The recommendation at `ask` is a question card (ADR 773), so nick answers it from `/live`, the
phone or, later, Slack, and the answer puts the seat back to work.

### Same state everywhere

- **`/live`:** each roster seat shows on shift / off shift, until when, budget left, and the stop
  reason when stopped; Start and Start everyone already exist; a Stop (end shift) joins them.
  Settings → a seat's shift (hours, budget, start, autonomy) beside its residency knobs.
- **CLI:** `musterd status` and `musterd residency status` carry the same line; `musterd residency
  policy --hours … --budget-usd … --start auto|manual --autonomy ask|claim|free [--seat]`;
  `musterd start <seat> | --all`, `musterd stop <seat>`.
- **MCP:** `team_status` shows the shift line; the seat's own `team_next` tells it its shift bounds.
  No new tool for setting shifts from a seat: a seat does not set its own hours. **fifty's call.**

## Goals, non-goals, anti-goals

**Goals**

- From `/live` or the CLI, nick can run a day with seats on the joiner or on Cloud without opening a
  terminal: Start, watch them orient and take asks, answer their questions, see them stop.
- A human's act never waits on a rate gate.
- A seat with claimed work does it without being prodded, and stops when the guardrails say.
- One settings shape for all of it, team default + per-seat override, on every surface.

**Non-goals**

- Changing how *agents* wake *each other*. Off-shift wakes keep ADR 131's lanes and caps.
- Changing the spend gates (ADR 611/636). They stay the backstop and are not raised by a shift.
- Scheduling beyond hours (calendars, per-day hours). One weekly window per seat is enough now.
- A seat claiming work at `ask`. Recommendation is the whole point of the default.

**Anti-goals (a failure even if it works)**

- A seat that runs all night because the hours or budget were unset: the defaults must stop it.
- A shift that silently ends. Every stop has a reason a person can read.
- Two states that disagree: `/live` says on shift, the CLI says off. One row, one reader.
- Replacing the caps with nothing. Machine-to-machine chains stay rationed.

## Constraints

- No new runtime dependency. Hours are evaluated with the team's stored timezone and `Intl`.
- `@musterd/protocol` changes (shift settings, shift state on the roster, the stop reason) are
  ADR-gated (hard rule 1).
- The wake derivation in `residency.ts` is the one place wakes are decided; a shift is a new
  derivation beside `immediate` / `batched` / `work_order` / `dream` (ADR 191/199), not a second
  actuator. `musterd host` is unchanged except for reading the composed line.
- A hosted seat on Fly that scales to zero (lane `01M64B25QM`) must be started by a shift wake like
  any other; the design assumes the host is reachable and leaves scale-to-zero to that lane.

## Prior art in the repo

- ADR 131 (residency, lanes, caps) · ADR 735 (`act` lane: no cooldown) · ADR 191/199 (work-order
  wakes from the board: the "keep working on your lane" precedent, gated by `loops.dispatch` and
  per-seat `flow: auto`) · ADR 611/636 (spend holds) · ADR 773/774 (questions and answers) · ADR 779
  (quick actions, daemon-composed lines) · ADR 044 (availability).
- The dispatch loop (ADR 199) already wakes a seat to continue a handed-off lane when `flow: auto`.
  **fifty's call:** a shift subsumes it for seats on shift: `flow: auto` stays as the off-shift
  trust-ramp toggle and is not needed for a shift wake.

## Left to the builder

- The exact shape of the shift row (per seat per day) and its ledger events.
- How the recommendation picks its items (team_next's per-member ranking is the obvious source,
  ADR up-next-relevance).
- Where the Stop button lives on `/live` and the copy of the shift line (brand glossary applies).
- Whether `musterd start` is a new verb or `musterd send --act steer --quick start` with an alias.
- The plan's increment order. **fifty's call on the first two:** (1) human acts pass the caps;
  (2) shift settings + the claimed-work wake, with hours and budget enforced, `start: manual`,
  `autonomy: ask`, and the stop line. Recommendation, `auto` start, `claim`/`free`, and the UI
  settings page follow.

## Open questions for nick

None. Resolved in the brainstorm: default autonomy is `ask`; self-start vs Start-only is a per-seat
setting; all three stop signals (clock, money, no work) are valid. Resolved after the builder check
(2026-11-03): the daily budget default is $10 per seat; shift hours reuse `working_hours`, and the
team's window becomes 09:00–18:00.
