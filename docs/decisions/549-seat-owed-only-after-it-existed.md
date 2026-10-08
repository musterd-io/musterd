# 549 — A seat is owed only what arrived after it existed

- Status: accepted
- Date: 2026-10-08
- Deciders: nick ("take" the alfie lanes, 2026-10-08)
- Lane: `01M4E4N1J3YYKE5N681JZA4MJM` (goal `seat-continuity`)
- Builds on: ADR 287 (the cursor never passes an unread this call did not render), ADR 429 (the
  pinned set is the obligation class), ADR 434 (what discharges an obligation)

## Context

alfie, a seat created on 2026-10-08 at 01:41 UTC, called `team_inbox_check` twice, minutes apart, and
got the same twelve messages both times, oldest first, starting at an ask from August. None named
alfie. `elided_unread` read 14,097, then 14,024. The lane's first reading was that shown messages were
not being marked read. They were not unread in the first place.

## Problem

`getCursor` returns `last_read_ts: 0` for a seat with no cursor row. Every read path that derives
"unread" from it (`listInbox`, the unread counts, wake delivery) then treats the team's whole history
as unread for a seat that has never read. For a seat created on day 90 of a team's life that is every
broadcast ever sent: 14,097 rows for alfie.

The twelve repeating rows are the pinned set. ADR 429 pins every undischarged obligation (`ask`,
`request_help`, and the other obligation acts) that falls above the cursor floor. A team-wide ask has no
single recipient, so nothing a new seat does can discharge it, and with the floor at 0 each one
sits at the top of every bounded read for as long as the ask stays open. Reading a pinned ask does not
discharge it, which is why a second check returned the same rows. That is the intended behavior for a seat that
owes the answer. alfie owed none of them: most were sent before alfie existed.

## Decision

A seat that has never read starts its cursor at the instant before it was created. `getCursor` reads
the seat's own `members.created_at`, minus one millisecond, as the floor when no cursor row exists.

- **The floor is the creation instant, not the head at creation.** `created_at` is already on the row,
  so there is no migration and no backfill: every existing seat with no cursor row (alfie included)
  is corrected on its next read.
- **Minus one millisecond.** `team add` writes the `@team` agent-created notice right after the
  member row. The read filter is `created_at > floor`, so a floor of exactly `created_at` would drop
  an act sent in the creation millisecond.
- **An explicit cursor wins.** A seat with a cursor row is read exactly as before, including rows that
  pre-date its creation. The floor applies only to "never read".
- **No change to the pinning rule.** ADR 429 stands. An ask sent after the seat existed is pinned
  for it and stays pinned until discharged.

Rejected: writing a cursor row at member creation. It leaves every seat created earlier broken
and needs a backfill migration. Rejected: exempting team-wide asks from pinning for seats that never
read. That is a second rule for one symptom, and the floor removes the symptom's cause.

## Consequences

- A new seat's inbox is empty of pre-creation team history. The history stays readable: `inbox --all`,
  the firehose, `ids: [...]` and the lane board are unchanged. A seat that needs older context reads it on purpose.
- On a joiner daemon the log is folded after its members exist, so folded rows carry a later
  `created_at` and still count as unread for a seat with no cursor. That case behaves as it did before
  this ADR; it is not made worse.
- Test fixtures that stamp messages with fake early times must create their members earlier. Five
  fixtures did (`delivery`, `discharge`, `residency.dream`), and each now ages its members with a
  comment pointing here.
- The lane's other half, "shown acts aren't marked read", is not a defect: a pinned obligation stays
  until it is answered or discharged, whether or not it was displayed.

## Observability & Evaluation

- **Traces:** n/a. This changes a store read, not an agent's tool path.
- **Eval:** the falsifier is a new seat reading old team history. Create a seat after a team-wide ask;
  its `GET /inbox?unread=1` must not contain the ask, and an ask sent after the seat exists must be
  contained. Dataset: alfie, 2026-10-08 (14,097 unread, twelve pinned). Baseline: before this ADR both
  were present. Reproduced by `store/inboxNewSeat.test.ts`.
- **Experiment:** n/a. Mechanical, and verified by the test above.
