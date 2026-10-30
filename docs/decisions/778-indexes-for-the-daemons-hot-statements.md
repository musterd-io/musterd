# 778 — Indexes for the daemon's hot statements

- Status: accepted
- Date: 2026-10-30

## Context

On 2026-10-29 and 2026-10-30, the revive hub (nick's laptop) stalled under load. The guardian raised
`daemon_wedged` at 21:28 on 10-29, and `/health` took 1.5–20 s with timeouts. A five-minute side-by-side
probe on 10-30, run every 2 s, timed `/health` and a static page that never touches the database
(`/authority/passkey`). Both stalled. The static page reached 18.7 s, with p95 7.7 s against a 0.002 s
median. In 19 of 150 samples both were slow together. So the whole event loop was blocked, not one
route. The laptop's load average ran 3–31 during the probe (a Blender batch render and vite builds).

The daemon's own log between 11:16 and 15:22 on 10-30 named the cause: 7,184 `sqlite_stmt_slow`
lines and 2,782 `event_loop_stall` lines. A few statements carried most of the time:

| statement (source) | runs | total | max |
| --- | --- | --- | --- |
| owed reviews, `deriveNextSummary` (`store/orientation.ts`) | 1,307 | 867 s | 7.4 s |
| `dbstat` walk of `sync_log`, `/health` store sizes (worker) | 28 | 704 s | 70.4 s |
| interrupt raises, `json_extract(detail,'$.act')` (`store/delivery.ts`) | 978 | 352 s | 3.6 s |
| review ask by lane, `json_extract(meta,'$.lane_review.lane') = ?` (`store/review.ts`) | 533 | 330 s | 3.7 s |
| digest by day, `json_extract(meta,'$.digest.day') = ?` | 204 | 176 s | 4.6 s |
| lanes by owner / all lanes, `ORDER BY created_at` | 689 | 244 s | 5.0 s |

Each of these filters on a JSON path or sorts on a column that no index covers. So SQLite walks
every row the leading index matches and evaluates `json_extract` on each one. The walk is cheap on
a quiet copy and costs seconds once the disk is contended.

nick ran a script on a copy of the hub store that printed plans and timings only (34,988 messages,
414,039 audit rows, 2,722 lanes). It timed each statement with the live schema, then with these
indexes added:

| statement | before | after |
| --- | --- | --- |
| digest by day | 123.4 ms | 0.00 ms |
| all lanes | 77.7 ms | 33.8 ms |
| owed reviews (per seat) | 29.2 ms | 10.0 ms |
| review ask by lane | 13.0 ms | 0.00 ms |
| wake count by act | 10.5 ms | 4.4 ms |
| lanes by owner | 9.1 ms | 0.58 ms |
| interrupt raises | 0.31 ms | 0.00 ms |

With the indexes in place, an insert cost 0.37 ms on `messages` and 0.20 ms on `audit`. The
script did not time inserts without them, so the per-insert delta is bounded above by those
figures, not measured.

The measured set included an `audit` expression index that this decision does not ship
(Decision 2). Three rows above owe their gain to it: owed reviews (29.2 → 10.0 ms), wake count
by act and interrupt raises. With the shipped set, those three keep today's plan. The digest,
review-ask and lane-list rows do not depend on it.

## Problem

Cut the event-loop time these statements hold. Keep their SQL dialect-neutral: Postgres stores run
the same queries through the dialect's `json_extract` rewrite. Do not reopen the write cost that
[ADR 750](./750-analyze-statless-tables.md) removed when it dropped a full-coverage `messages` index.

## Decision

1. **Ladder step v137 adds four indexes on SQLite**, each matching the expression its statement
   already uses, so no query changes:
   - `idx_messages_lane_review` on `messages(team_id, json_extract(meta, '$.lane_review.lane'))`,
     partial `WHERE act = 'ask'`. Only asks carry the entry, so most inserts never touch it.
   - `idx_messages_digest_day` on `messages(team_id, json_extract(meta, '$.digest.day'))`, partial
     `WHERE json_extract(meta, '$.digest.day') IS NOT NULL`: one row per digest.
   - `idx_lanes_team_owner_created` on `lanes(team_id, owner_seat, created_at)` and
     `idx_lanes_team_created` on `lanes(team_id, created_at)`.

   `analyzeTablesMissingIndexStats` analyzes both tables after the ladder runs, as it does for
   every new index (ADR 750).
2. **No expression index on `audit`.** An index on `json_extract(detail, …)` is evaluated on every
   insert, and `audit.detail` may hold text that is not JSON by design: `reviewRouting` abstains on
   such a row (ADR 173). With that index, the insert throws `malformed JSON`, and CI caught it on
   the first push. The interrupt-raises and wake-count statements keep today's
   `idx_audit_team_action_target_ts` plan. On the copy that was 0.31 ms and 10.5 ms, the smallest
   gains measured.
3. **On Postgres, v137 adds only the two `lanes` indexes.** They are plain columns. The JSON indexes
   would have to match the dialect's rewritten expression and have not been measured there; hosted
   stores keep today's plan, as with [ADR 771](./771-partial-urgent-index.md).
4. **`/health`'s store-size walk runs at most every 6 hours** (`STORE_SIZES_TTL_MS`), down from every
   10 minutes. It stays off the event loop, but it reads every `sync_log` page; it took up to 70 s
   cold, 28 times in 4 hours. It is a growth signal, and nothing reads it as liveness.

The owed-reviews join compares `json_extract(m.meta, …)` with the TEXT column `l.id`, and SQLite will
not use an expression index for that comparison
([affinity](../wiki/sqlite-expression-index-affinity.md)). With no index it can seek, it stays at
today's plan, 29 ms on the copy. A virtual generated column would close that gap, but every query would then name a
column Postgres does not have. That is left for a measured follow-up, not done here.

## Consequences

- The first daemon start on v137 builds the indexes. On the copy that took 14.8 s, including
  `ANALYZE`, while the store is opened, before the daemon answers. The auto-refresher's health wait
  covers that.
- `audit` gains no index. `messages` gains two partial indexes, and an insert updates them only
  for an `ask` or a digest. Both evaluate `json_extract(meta, …)` on insert. That is safe because
  `meta` is always written as serialized, validated JSON or NULL. A store holding a row with
  malformed `meta` would fail v137 at boot; the revive hub's copy built cleanly.
- `/health`'s `sync_log_bytes` can be up to 6 hours old. `musterd status` shows it as a size, not a
  rate.
- The interrupt-raises and wake-count statements (978 and 294 slow runs in the window) are
  unchanged. A fix there needs a `detail` expression that tolerates non-JSON text, in both the index
  and the query. That is a follow-up, not part of this change.

## Observability & Evaluation

- Traces: the daemon already logs `sqlite_stmt_slow` (statement, ms) and `event_loop_stall`
  (stall_ms). The before figures above come from them. No new event.
- Eval: the per-statement totals from `daemon.log` for the same four-hour daytime window, before and
  after deploy. Falsifier: the review-ask, digest and lane-list statements still appear among the
  top five `sqlite_stmt_slow` totals after a day at comparable load.
- Experiment: repeat the side-by-side `/health` and static-page probe (150 samples, every 2 s) at a
  load average above 10. Success is the static page's p95 under 1 s, against 7.7 s before.
