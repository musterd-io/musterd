# SQLite expression-index affinity

Index a `TEXT` generated column, not the `json_extract` expression itself, when the comparison is against a `TEXT` column: the expression has no affinity, the column's affinity wins, and the planner then declines the expression index for that equality.

## The rule

SQLite uses an index on an expression only when the query's expression matches it exactly **and** no affinity conversion applies to the comparison. `json_extract(...)` returns a value with no affinity. Comparing it to a column declared `TEXT` applies TEXT affinity to the expression side (the column's affinity wins), so the planner treats the indexed expression as unusable for that equality and falls back to whatever index covers the remaining terms — here `messages(team_id, …)`, a per-row scan of the whole team.

A `VIRTUAL` generated column declared `TEXT` carries TEXT affinity, so an ordinary index on it is used. The column costs nothing at rest (virtual) and is the same expression by definition.

## The measured instance (2026-09-24; falsify: on a copy of a ~16k-row `messages` table, `CREATE INDEX i ON messages(team_id, json_extract(meta,'$.in_reply_to'))` and `EXPLAIN QUERY PLAN` the discharge `NOT EXISTS` from `discharge.ts` — the plan reads `USING INDEX i (team_id=?)`, one column, not two) <!-- claim: defect -->

The guardian raised `daemon_wedged` twice (11:52 and 12:00 local), each cleared in ~3 min, with 97% of samples in `sqlite3_step` under `Statement.all`. Per-statement timing of one `POST /residency/wake-leases` poll against a copy of the live DB:

| statement | calls | ms |
| --- | --- | --- |
| `openDirectedLedger` (three `NOT EXISTS` discharge clauses) | 2 | 7434 |
| `answerBy` (the recipient's own reply, `in_reply_to` OR thread) | 298 | 2079 |
| `resolve` on thread | 266 | 1727 |

Only the `answeredByAnyone` clause (`json_extract(dr.meta,'$.in_reply_to') = m.id`) carried the first number: 1.78 s alone, 0.01 s on a generated column. The poll runs every few seconds per host, so the event loop was blocked for most of every window while `/health` queued behind it.

Fixed by migration v71 (`packages/server/src/db/migrations.ts`): the column, four indexes, and an `ANALYZE messages`. Poll cost on the same copy: 12.6 s → 0.2 s.

## Two traps met on the way

- **`pragma_table_info` hides a VIRTUAL generated column.** A `cols.includes(...)` guard written against it re-adds the column on a migration replay and fails with `duplicate column name`. Use `pragma_table_xinfo` (2026-09-24; falsify: `SELECT name FROM pragma_table_info('messages')` after v71 — `in_reply_to` is absent; `pragma_table_xinfo` lists it). <!-- claim: other -->
- **Nothing in the daemon runs `ANALYZE`.** Without `sqlite_stat1` the planner kept choosing `idx_messages_team_ts` (it avoids the `ORDER BY` sort) over the new equality indexes, so two of the three hot statements stayed at ~5 ms per call until the migration analysed the table. `PRAGMA optimize` on close would keep the stats fresh; not wired as of 2026-09-24. _(2026-10-13: half of this went stale. Index migrations from v71 on ran `ANALYZE messages` themselves, so `messages` HAS statistics — and that is the worse case. See [below](#an-index-newer-than-the-tables-statistics-wins-plans-it-should-lose-2026-10-13).)_

## What it looked like from the request path (2026-09-24)

The daemon log for the lane window (12:50–13:15) shows three endpoints holding the loop ~1135 s of 1500 s — `wake-leases` 98 calls at 7.6 s, `/lanes` 39 at 5.9 s, `/report` 10 at 16 s — all through `openDirectedLedger`; `/inbox`, 52% of requests, averaged 48 ms. The guardian's `vdbeCommit → pagerWalFrames` sample read as "synchronous WAL commits are the problem", and that diagnosis was wrong: a single-row commit costs 0.026 ms on this DB and the daemon writes ~4200 audit rows an hour. The full numbers, the repaired load harness and the ranked levers are in [docs/perf/daemon-load-baseline.md](../perf/daemon-load-baseline.md).

## Where else this shape lives

`json_extract(detail, '$.act') = ?` on `audit` (`residency.ts`, several sites) is the same pattern on a 228k-row table. It is bounded today by `idx_audit_team_action_ts` narrowing on `action` first, so it did not show in the profile, but it is the next candidate if `audit` grows.

## An index newer than the table's statistics wins plans it should lose (2026-10-13; falsify: on a copy of a store at v94, `DELETE FROM sqlite_stat1 WHERE idx = 'idx_messages_thread_act_ts'`, `ANALYZE sqlite_schema`, and `EXPLAIN QUERY PLAN` the `answeredByAnyoneSql` clause from `discharge.ts` — before lane 01M4VGRX57 it reads `dr USING INDEX idx_messages_thread_act_ts (team_id=? AND act=?)`) <!-- claim: defect -->

Once a table has rows in `sqlite_stat1`, SQLite plans from them, and an index with no row of its own gets default estimates that look far more selective than measured ones. v93 added `idx_messages_thread_act_ts` with no `ANALYZE`, onto a `messages` last analyzed at 17,207 rows. On the revive hub's 25k messages the open-directed ledger's "answered by anyone" clause switched to the new index: it walked all 1,685 of the team's accept/decline rows for each of 468 candidate acts instead of seeking `idx_messages_in_reply_to`. The ledger's root query took 3.2 s warm, and every wake-lease poll ran it — p50 1.28 s, p90 2.8 s over two hours. A fresh `ANALYZE messages` (0.3 s) brought the same unchanged query to 0.026 s, and a whole poll from 2.3–3.1 s down to 0.12–0.34 s across the hub's four hosts.

Statement count was not the cost: the poll still issues ~740–960 statements, each an indexed seek under 1 ms. A per-call timer around the async driver charged them seconds each, because the calls hydrate concurrently and every one waited behind the one slow query. Time the SQL alone in `sqlite3` with `.timer on` before you believe a per-call profile.

FIXED in `runMigrations` (2026-10-13, lane 01M4VGRX57; falsify: after a daemon start on this build, the query in this section's heading returns no index of an analyzed table missing from `sqlite_stat1`): after every ladder run, `analyzeTablesMissingIndexStats` re-analyzes any table that has statistics but is missing one of its indexes from them. A migration that forgets `ANALYZE` can no longer leave the trap. A table with no statistics at all is left alone, because there every index gets the same defaults. <!-- claim: defect -->
