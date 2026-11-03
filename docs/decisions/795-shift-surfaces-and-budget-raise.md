# 795 — Shift settings on every surface, and asking to raise a spent budget

- Status: accepted
- Date: 2026-11-03

## Context

ADR 792 and ADR 793 built seats on shift: Start, the claimed-work wake, the stops, the
recommendation, `claim`/`free` and `shift_start: auto`. Four things the design
(`docs/superpowers/specs/2026-11-02-seats-on-shift-design.md`) asks for were left to this last
increment:

- the shift knobs on `/live`, beside the residency knobs;
- a seat on shift learning its own bounds when it orients;
- a CLI verb for Start and Stop;
- a Start after a `budget` stop should ask a person to raise the day's budget, not run.

## Problem

The shift knobs could be set only from the CLI. A seat on shift could not tell from `team_next` how
long it had or how much budget was left. A Start after a budget stop recorded a new shift that the
derivation refused at once, so the seat went straight back to `budget` with no way for a person to
say "spend more today".

## Decision

1. **`/live` settings gain a Shifts group.** It holds the team defaults for `shift_budget_usd`,
   `shift_start` and `autonomy`, in the same table-driven form as the other policy knobs. Per-seat
   overrides stay on the CLI (`musterd residency on|policy --seat`).
2. **`team_next` opens with the seat's shift.** Under the brief's first line: `On shift until 15:00,
   $4.10 left. Work your claimed lanes; answer what is directed at you.` For an ending shift: `Your
   shift is ending (…): finish the step you are on and end your turn.` Nothing off shift or for a
   human. The MCP adapter reads it from the roster's `shift` (ADR 792), so no server route changes.
3. **`musterd shift start <seat>` and `musterd shift stop <seat>`.** They send the same quick-action
   steer `/live` sends. The verbs live under `shift`, not as bare `musterd start|stop`, because
   `musterd service start|stop` is the daemon.
4. **A Start after a budget stop asks.** When today's shift stopped on `budget` and a person presses
   Start, the seat does not go on shift. It asks that person one ADR 773 question: "Today's budget
   is spent. Add $X for today so I can go back on shift?", where X is one day's policy budget.
   - Yes adds X to that day's budget (audit `shift.budget_raised {day, usd}`) and starts the shift.
     The day's budget is the policy's plus every raise for that day. It never carries to another day.
   - No, or any other answer, closes the question (`shift.budget_declined`) and the seat stays off.
   - Only a person who may change the seat's policy is asked: an admin, or the seat's sponsor (the
     ADR 501 halt rule). The answerer's authority is checked again when the answer is settled. A
     seat's budget is raised at most twice a day.
   - While one question is open for the day, another Start does not ask again.
   - The shift watch settles answers once a minute (`settleBudgetAsks`).

## Consequences

- From the commit security review (2026-11-03): the first draft asked whoever pressed Start, so
  any person on the team could raise a seat's spend. Raising is now an admin's or the sponsor's,
  checked at ask and at answer, and capped at two a day.
- The seats-on-shift goal's planned increments are all built: ADR 790, 792, 793 and this one.
- A person can raise a seat's budget only for today, and only by answering the seat's question.
  A standing change is still the policy knob.
- Follows-up: lane `01M67EBYQ1` (the end-to-end check, which now has a shift to exercise as well as
  a question).

## Observability & Evaluation

- **Traces:** audit `shift.budget_asked {question, day, usd}`, `shift.budget_raised {question, day,
  usd}`, `shift.budget_declined {question, day}`; the question's own ADR 773 rows.
- **Eval:** `shiftWatch.test.ts` pins that a Start after a budget stop asks the person who pressed
  it, does not ask twice, puts the seat back on shift with the raised budget on yes, and stays off
  on no. `next.render.test.ts` pins the `team_next` shift line. `policyKnobs.test.ts` pins the
  settings group. `shift.test.ts` (CLI) pins the verbs' argument checks.
- **Experiment:** for two weeks, count budget raises per seat per week. **Falsify:** a raise on most
  working days for the same seat, which would mean that seat's day budget is set too low and the
  policy knob should move instead.
