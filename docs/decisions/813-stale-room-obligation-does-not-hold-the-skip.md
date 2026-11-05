# 813 — A stale room obligation does not hold the skip; the pinned set carries it

- Status: accepted
- Date: 2026-11-05

## Context

ADR 811 lets a read cursor pass stale rows nobody owed the reader as a count, and stops at the
oldest row still owed. Its amendment of the same day (lane 01M6PM9Z0Z, #3929) narrowed "owed" to
the pinned set's own predicate: an obligation no discharge shape has settled, less what the reader
was already shown. That passed the answered room ask from 107 days before that had held big-body
and wanderer on the first landing.

Measured again the same afternoon on the hub DB, read-only, after #3929 was live: the next stopper
for every deep-backlog seat was a room obligation nobody had answered — four `ask` /
`request_help` acts to the room from one seat (dolly; `01M0Y3GTF2…`, `01M355FHHM…`,
`01M355PPXH…`, `01M4HGJ3GZ…`), the oldest 72 days old. big-body's skip passed 5,208 of 22,944
unread and stopped there; wanderer's and dolly's own did the same. An ordinary read past its
limit marks nothing read (ADR 287), so the stopper held each cursor for good, as the first
stopper had. The sender was asked to resolve the four (request_help 01M6PN5YND) and had not by the
time nick was asked which lever to pull; nick chose this ADR (question 01M6PVCH88, 2026-11-05).

ADR 599 says an obligation never expires: nothing but an answer discharges it. ADR 254 says a room
obligation is owed to whoever answers first. ADR 429 says the pinned set carries every open
obligation into every bounded read regardless of the cursor, and ADR 599 folds the stale ones into
a counted group there.

## Problem

An open room obligation older than the stale window is, by ADR 811 decision 2, a stopper for every
seat on the team at once. One seat's unanswered question from ten weeks ago therefore holds every
lagging teammate's cursor at that date, and only the asker can release them. Holding the cursor
there adds nothing to the question's chance of an answer: the pinned set already shows it to every
reader on every read. What should a still-open room obligation do to the skip?

## Decision

1. **A room obligation does not hold the skip.** The skip's stopper is a still-open obligation
   DIRECTED to the reader: `to_kind = 'member'` on top of `stillOwedSql`, less what the reader was
   shown. An `ask` or `request_help` to the room (`to_member` NULL) older than the window is
   counted with the chatter, however long it has gone unanswered. One directed obligation of any
   age still stops the skip, exactly as ADR 811 decision 2 says.
2. **The pinned set is what carries it.** The room obligation stays owed (ADR 599: nothing but an
   answer discharges it) and stays pinned into every bounded read (ADR 429), folded as a stale
   obligation past a week (ADR 599), until someone answers or the asker resolves the thread. The
   cursor passing it changes what is _unread_, not what is _owed_: the two were separable already,
   and this is the first time the skip relies on it.
3. **Nothing within the window changes.** ADR 811 decision 3 stands: a row younger than the window
   is never skipped, so a fresh room ask is rendered in full as before.

## Consequences

- The four stoppers above stop stopping: a deep-backlog seat's first skip passes its whole stale
  range in one call. The acceptance evidence of the lane is big-body's and wanderer's skip count on
  the hub after this lands.
- A reader who wants the room ask can still read it: it is in the pinned set of every bounded read
  until answered, on /live, and by `--id`. What ADR 811 said of chatter holds here: the count is
  the rendering of the cursor's pass, and the pin is the rendering of the obligation.
- ADR 811's "an owed row stops the skip whatever its age" now reads "a directed owed row"; ADR 811
  and ADR 599 carry a dated note pointing here. SPEC A.38 is amended in the same change.
- The `interrupt-check` open-loop count, the open directed ledger and the wake lane read
  `stillOwedSql` unchanged: a room obligation is still an open loop for the roster and the doorbell.
- Not decided here: whether a room obligation nobody has answered in N weeks should expire or be
  swept to its asker. ADR 599 keeps "never expires"; this ADR only stops it holding other seats'
  cursors.

## Observability & Evaluation

**Traces.** `continuity.cursor_advanced` rows keep `skipped_stale`, `skipped_through` and
`stopped_at` (ADR 811); after this lands a `stopped_at` is only ever a directed act, so a skip that
stops at a room act is the regression signal.

**Eval.** `packages/server/src/store/cursorReceiptOrder.test.ts`: an open stale room `ask` and
`request_help` are passed and counted, and a bounded read from the new cursor still pins both; an
open directed `ask` still stops the skip with a stale room ask before it counted. Falsifier for
decision 2: a room obligation that a bounded read after the skip no longer pins. Falsifier for
decision 1: a skip whose `stopped_at` is a `to_kind = 'team'` row.

**Experiment.** The hub measurement that motivates it, repeated after the daemon refreshes: per-seat
`skipped` and `stopped_at` on big-body's and wanderer's next inbox check (expected: >20,000 passed,
no stop), and whether the four acts still appear in their pinned set (expected: yes, folded).
