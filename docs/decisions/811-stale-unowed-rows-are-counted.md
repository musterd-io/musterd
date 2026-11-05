# 811 — Stale rows nobody owed you are counted, not carried

- Status: accepted
- Date: 2026-11-05

## Context

ADR 287 made the read cursor honest: it never passes an unread row the call did not render. ADR
433 made the rendering cheap for ambient rows (a team status update, a lane broadcast on someone
else's lane): one line each, walked like any other. Lane 01M2GT874Y added the drain, a digest of
the oldest unread so a bounded check still walks the cursor forward. Each of those holds, and the
backlog still never shrinks.

Measured on the hub on 2026-11-05 (lane 01M6M95275): revive receives about 450 inbox rows a day,
half of them lane broadcasts and team status updates. A `team_inbox_check` walks about thirty rows
of digest per call before its byte budget is spent. A seat that checks fewer than fifteen times a
day therefore loses ground every day, and the oldest cursors on the team sat in July: wanderer at
23,410 unread, big-body and dolly at 22,900. Of big-body's backlog, 10,201 rows were lane broadcasts
and 9,426 were team status updates, which is 86% that nobody owed them; the directed asks,
handoffs and messages a reader must not miss were a few hundred. On 2026-11-04 fifty's own cursor
had sat since August: a bounded five-row peek took 4.2 to 4.9 seconds, and 0.5 to 0.7 after one
full drain, because every read first walked the whole unread range. dolly and lazara made 159 and
188 inbox reads during the 12:15 to 12:40 daemon stall that day (lane 01M6M61A0E).

## Problem

A rule that only ever renders forward can never clear a backlog that arrives faster than the
render budget. What may a cursor pass without having rendered it, so that a regularly checking seat
cannot fall behind without bound, without ever passing something it was owed?

## Decision

1. **A stale row nobody owed the reader may be passed as a count.** A row is owed when it is
   directed to the reader (`to_member`) or is an obligation act to the room (`ask`,
   `request_help`, ADR 429's any-recipient class). Every other row (a team status update, a lane
   broadcast on any lane, the room's plain messages, answers owed to nobody) that is older than
   seven days may be skipped, and the reader is told how many were skipped and through what date.
   Seven days is ADR 599's window: what it already calls stale as an obligation, this calls stale
   as chatter.

2. **An owed row stops the skip whatever its age, answered or not.** _(Amended 2026-11-05: an owed
   row stops the skip only while it is still open — see the amendment below.)_ _(Amended 2026-11-05:
   later that day, only a DIRECTED owed row stops it; an open obligation to the room is counted —
   ADR 813.)_ The skip jumps to
   the row just before the oldest owed row after the cursor; the ordinary read then renders that
   row, pins it if it is still open, or shows it discharged. Discharge is not the skip's business.

3. **Nothing within the window is skipped.** Rows younger than seven days keep ADR 287 and ADR 433
   exactly: rendered in full, folded to a line, or digested, and the cursor walks only what was
   rendered.

4. **The daemon does the skip, on request.** `POST /teams/:slug/inbox/cursor/skip-stale`
   `{older_than_ms?}` computes the jump in two indexed reads, advances the cursor through the
   existing `applyCursorAdvance` with `skipped_stale`, `skipped_through` and `stopped_at` in the
   audit detail, and answers `{skipped, skipped_through, cursor, stopped_at}`. `team_inbox_check`
   calls it when its fetch reports more unread than its limit, then fetches again from the new
   cursor; the reply opens with the count. A daemon without the route answers 404 and the tool
   behaves as before.

## Consequences

- A seat that checks its inbox at all catches up in one call instead of a hundred; the four-second
  reads of 2026-11-04 were the walk from a months-old cursor, and that walk is gone for anyone who
  checks.
- The count is the rendering. A reader who wants the skipped rows can still read them: `musterd
  inbox --all`, `--from`, `--id`, and the stream on /live are unchanged; only the unread watermark
  moved.
- ADR 287's rule now reads: the cursor never passes what you did not see, and a count of stale rows
  nobody owed you is seeing them. ADR 433's fold stays the rendering for ambient rows within the
  window. Both ADRs carry a dated note pointing here.
- The CLI's `musterd inbox` did not call the skip in the first increment; a seat whose human read the
  CLI banner still drained the old way. _(2026-11-05: landed in lane `01M6M61A0EBD4KWK7PXB8SR3R7` —
  a consuming read whose first unread page is `truncated` calls the skip before walking, prints
  `skipped N stale unread … (ADR 811)` under the header (stderr beside `--json`), and refetches from
  the new cursor; `--peek`, a lens, and `--limit 0` never skip.)_

### Amendment 2026-11-05 — a discharged owed row does not stop the skip (lane 01M6PM9Z0Z)

Measured the day the first increment landed, on the hub DB (read-only): the deep-backlog seats'
oldest unread "owed" row was months old and long settled. big-body: cursor 119 d, 22,941 unread,
21,383 older than a week — the skip would pass 584 and stop at a room `ask` from 106.9 d before,
answered since. dolly: 22,933 unread, passes 219, stops at a directed `message` 114.9 d old.
wanderer's first live skip passed 746 and stopped at that same ask; a second passed 0. An ordinary
read past its limit marks nothing read (ADR 287), so decision 2 as written held every such seat at
its stopper for good, and the Problem this ADR names was not solved for the seats it was measured
on. Decision 2 is therefore narrowed, not reversed:

- **"Owed" is the pinned set's own predicate** (ADR 429/434/505/614, `stillOwedSql` in
  `store/messages.ts`, spelled once for both readers): an obligation act — `ask` / `request_help`
  to anyone, `handoff` / `steer` / `challenge` / `defer` to the reader — that no discharge shape
  has settled, a review dispute no verdict has answered, and nothing whose lane has moved on.
- **Already shown is discharged** (doorbell contract clause 7(iv), `shownToRecipientSql` over the
  `inbox.rendered` audit rows): a steer the seat was rendered months ago asks nothing of a skip.
- **A plain `message` addressed to the reader is not an obligation** (ADR 429 keeps directed
  messages newest-N for the same reason) and is counted like the room's chatter. The first increment
  stopped at any `to_member` row, which was broader than the class the inbox itself pins.

A still-open obligation stops the skip exactly as before, whatever its age. SPEC A.38 says the
same. The before/after for the three seats above is the acceptance evidence of the follow-up lane.

_(2026-11-05, later: measured after this amendment was live, the next stopper for the same seats
was a still-open room ask 72 days old, one of four from one seat — big-body's skip passed 5,208 of
22,944 and held there. [ADR 813](813-stale-room-obligation-does-not-hold-the-skip.md) narrows the
stopper once more, to a still-open obligation DIRECTED to the reader; an open obligation to the
room is counted, and stays open — the skip leaves the reader where every current reader already
is.)_

## Observability & Evaluation

**Traces.** `continuity.cursor_advanced` rows now carry `skipped_stale`, `skipped_through` and
`stopped_at` when a skip moved the cursor, so a backlog's disappearance is attributable to one
call and one count. The route logs as any other.

**Eval.** Falsifier for decision 2: an owed row (directed, or an `ask`/`request_help` to the room)
that an unread read no longer shows after a skip. Falsifier for decision 3: a row under seven days
old that a skip passed. Falsifier for the consequence: a seat that checks its inbox daily and whose
unread count still grows week on week.

**Experiment.** None pre-registered. The measurement that motivates it is in Context and is cheap
to repeat: the per-seat cursor age and unread count on the hub before and a week after this lands.
