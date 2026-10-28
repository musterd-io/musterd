# 750 — Analyze the tables that have no statistics at all

- Status: accepted
- Date: 2026-10-28

## Context

Lane `01M4YY5Z38XVY7F9BQMKDN2A2Q` (the wake-leases daytime tail) measured its remaining step on
2026-10-28: a daytime window (09:30–09:49 local) of the daemon's own lines at swap 1427 MB — under
the 1.5 GB threshold the lane's earlier window used to separate paging from process work. The
wake-lease polls are fast now: p50 4 ms, p90 117 ms, max 2 669 ms over 279 polls. The lane's daytime
target (p90 under 400 ms) is met.

But the same window holds 13 `event_loop_stall` lines (553–2 508 ms) and 32 `sqlite_stmt_slow` lines,
and every slow poll sits on the same second as a stall. Swap was under the threshold, so this is not
paging — it is the process blocking itself. The statements in the stalls run on tables that have no
planner statistics: the audit high-water mark in `prunableSql` (`retention.ts`, 1 562 ms), the usage
aggregate (`insights`, 1 792 ms), and a `wake_leases` EXISTS check (925 ms). On a copy of the live
database, `SELECT * FROM sqlite_stat1` returns 15 rows — every one for `messages`; `audit`,
`wake_leases`, `lanes`, `sync_log` and 33 more tables have an index but no statistics row at all.

`analyzeTablesMissingIndexStats` (2026-10-13, lane 01M4VGRX57) re-analyzes a table that **has**
statistics but is missing one of its indexes from them, and deliberately leaves stat-less tables
alone: "there every index gets the same defaults". That rationale holds for the trap it guarded — a
new index outranking an old one on default estimates — but it is not the whole cost: with no
statistics the planner has no reason to prefer a covering seek over a scan at all. Measured on the
live copy, with bounds applied, the audit hwm subquery ran 94 ms before `ANALYZE audit` and 9 ms
after (the plan switches to `idx_audit_origin`); analyzing all 37 stat-less tables costs 251 ms once
(213 ms of it is `audit`, 329k rows). The empty `sqlite_stat1` this machine's database had through
2026-10-27 was the same trap at its extreme: nothing was analyzed, and every multi-index query —
including the wake-lease poll's own ledger read, 0.566 s cold on a copy — planned from defaults.

## Problem

A live database whose statistics exist for only some tables keeps planning the others from defaults,
and the guard that was built to stop exactly that only fires for tables already inside
`sqlite_stat1`. The daytime stall tail at low swap is that gap, measured.

## Decision

1. `analyzeTablesMissingIndexStats` also analyzes every table that has an index but no statistics
   row at all — same call, after every ladder run. A table it has analyzed now has statistics, so it
   is not analyzed again until a new index lands; the steady-state cost on a healthy store stays one
   read of `sqlite_master`.
2. Migration v133 drops the two `urgent` indexes and the `urgent` virtual generated column from
   `messages`, then re-runs `ANALYZE messages`. These objects were applied to the revive hub's
   database out-of-band during this lane's diagnosis (2026-10-27/28, before this migration was
   written) and no query on `main` uses them: with statistics present, the poll's ledger read seeks
   `idx_messages_team_ts` and the candidates read seeks `idx_messages_inbox_cover`, with or without
   the column (measured on the copy, both plans identical). The full-coverage
   `idx_messages_team_to_kind_urgent` cost an index update per message insert for nothing. The
   migration's guards make it a no-op on a store where the out-of-band step never ran.
3. The `openDirectedLedger` SQL is not changed: the predicate stays `json_extract(m.meta,
   '$.urgent') = 1`, which the dialect layer already translates, and which needs no new column on
   Postgres.

## Consequences

- The first boot after this change runs up to ~250 ms of `ANALYZE` (on this database's sizes) inside
  the ladder run — a one-off, measured. Later boots pay the `sqlite_master` read.
- The wiki's sqlite-expression-index-affinity page said stat-less tables are left alone; it carries a
  dated amendment pointing here.
- The `dbstat` walk behind `syncLogBytes` (`SELECT SUM(pgsize) FROM dbstat …`, 1.0–1.6 s cold on the
  live database) is not planner-fixable — `dbstat` is a virtual-table walk, not a query planning
  from defaults. It stays, recorded in the perf log, for whichever lane takes the retention read.
- The lane's earlier out-of-band application to the hub's database is now explained by a migration
  instead of a mystery column: the live store is reproducible from the ladder again.

## Observability & Evaluation

- **Traces:** none new. The existing `sqlite_stmt_slow` and `event_loop_stall` lines (#2603) are the
  instrument; this ADR's Context is read from them.
- **Eval:** `db.test.ts` pins that a table whose indexes have no statistics row is analyzed by the
  guard, and that a store with an entirely empty `sqlite_stat1` gets analyzed wholesale — the two
  states the hub actually passed through. `ladder.ts` v133's drop is covered by the migration's
  own guards in the ladder test.
- **Experiment:** the numbers above are the experiment — a copy of the live database, before/after
  `ANALYZE` on the 37 stat-less tables, with the query plans named. Falsifier: a daytime window on a
  post-merge daemon still shows `event_loop_stall` seconds coinciding with slow statements on tables
  that have statistics rows — then the stall has another cause and this ADR's fix did not cover it.
