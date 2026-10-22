# 712 — A wait silences the acceptance interrupt

- Status: accepted — 2026-10-22
- Date: 2026-10-22
- Lane: `01M5JBJ0Q00H5XJMTGDDQG0N24`
- Deciders: nick (asked for the bell to stop), sloane

## Context

A routed acceptance ask is obligation-class (ADR 225). It rings the stop hook at every tool boundary and again at the end of the turn, until an `accept` or a `decline` names it. `wait` was added so a seat can say "I have this" without moving the lane. The fold kept the ask on the line after that reply. On 2026-10-22 sloane's `wait` `01M5GX376MY8HVR9B355PJJ16Z` on miley's ask `01M5GX16NTA27Q0D5JGDG4MCY0` left the hook firing at the end of every turn.

## Problem

The acknowledge move and the bell use different rules. `wait` records the review and leaves the verdict open. `pendingInterrupts` treats an obligation as still owed unless an `accept` or a `decline` names it. A seat that has already answered `wait` hears the same ask again at every boundary, and the only replies that quiet the hook are the two that decide the lane.

## Decision

1. A `wait` from the seat that names an obligation by `meta.in_reply_to` silences that obligation on the interrupt line for that seat.
2. The lane stays in `awaiting_acceptance`. `wait` is not a verdict.
3. A co-addressee is unaffected. One seat's `wait` does not stand the others down.
4. A chat reply does not silence an obligation. `accept` and `decline` still discharge it for every named seat.

## Consequences

- The stop hook goes quiet for the seat that waited. The ask stays on the board until someone accepts or declines.
- The running daemon serves the fold it was built with. This record reaches it when the build that contains it is the daemon's build.

## Observability & Evaluation

- Traces: `interrupt.raised` stops naming an obligation for a recipient once that recipient's `wait` with `in_reply_to` is in the fold. A co-addressee's raise is unchanged.
- Eval: `pendingInterrupts` and `listInterruptCandidates` cover the wait, the co-addressee, and a chat reply that must not silence the ask.
- Experiment: n/a — the rule is the fold, measured by those tests.
- Falsifier: after a seat sends `wait` with `in_reply_to` set to an open acceptance ask, the next `inbox --interrupt-check` for that seat still names that ask. Then the fold is wrong and the wait stands as a recorded acknowledgement only.
