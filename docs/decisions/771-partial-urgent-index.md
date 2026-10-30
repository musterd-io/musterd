# 771 — A partial index for urgent directed messages

- Status: accepted
- Date: 2026-10-30

## Context

The lane gate's PreToolUse hook has a 1.5 s budget, and on 2026-10-29/30 it often ended
"unenforced (gate unreachable)" on the hub laptop and on the Linux joiner (lane `01M654E2GD`). The
gate's own handlers answer in milliseconds; the requests were queueing behind the hub's event-loop
stalls. In one hour there were 342 stalls, about 480 s frozen in total, roughly 13% of the hour.

The largest main-thread blocker was `openDirectedLedger`'s messages scan. It feeds
`claimWakeLeases`, which every wake host polls every 10 s, and there are now three hosts. In
`daemon.log` the scan logged 804 slow runs in one window: 617 s in total, an average of about
770 ms, and a maximum of 6.4 s.

ADR 750 (lane `01M4YY5Z38`) studied this read and kept its SQL unchanged. Its migration v133 also
dropped the out-of-band `urgent` indexes: it found the plans identical with or without them, and
the full-coverage `idx_messages_team_to_kind_urgent` cost an index update on every message insert.

## Problem

The read is `act IN ('request_help','handoff') OR (to_kind = 'member' AND json_extract(meta,
'$.urgent') = 1)`. `idx_messages_thread_act(_ts)` can serve the first arm, but nothing serves the
second, so the planner walks every team message through `idx_messages_team_ts`.

Measured on a copy of the revive hub's database (34,708 messages; nick ran the script, which
printed plans and timings only):

| read | median | plan |
| --- | --- | --- |
| current SQL | 47.6 ms | `SEARCH m USING INDEX idx_messages_team_ts` |
| act arm alone | 3.8 ms | `idx_messages_thread_act` |
| urgent arm alone | 32.4 ms | `idx_messages_team_ts` |
| urgent arm, with a partial index | 0.2 ms | the partial index |
| **current SQL, with a partial index** | **3.2 ms** | `MULTI-INDEX OR`: `idx_messages_thread_act_ts` + the partial index |

The warm copy is about 15× cheaper with the index. The live hub is far slower than the copy (it is
under load, its cache is cold, and the sizes worker is doing I/O), so the absolute saving there is
larger still.

## Decision

1. Migration v135 adds `idx_messages_urgent_directed ON messages(team_id, ts) WHERE to_kind =
   'member' AND json_extract(meta, '$.urgent') = 1` and re-runs `ANALYZE messages`.
2. `openDirectedLedger`'s SQL is unchanged. The planner picks the index up for the query as written
   (measured above). ADR 750 decision 3 stands.
3. The index is partial, unlike the full-coverage one ADR 750 dropped. Only urgent
   member-directed rows enter it (3 of 34,708 on the hub), so ordinary inserts never touch it.
   This narrows ADR 750 decision 2's finding to the index shapes it measured; it does not reverse
   it.
4. Postgres: no step. Nothing has been measured there, and the dialect's `json_extract` rewrite
   would need its own expression index. Hosted stores keep today's plan.

## Consequences

- The wake poll's ledger read stops walking the whole message log. The row cache from PR #3618
  (same lane) also stops repeat reads between messages; the two compose.
- One more index on `messages`, holding only urgent directed rows; its insert cost is
  negligible at today's urgent rate.
- ADR 750's Consequences gain a dated pointer here.

## Observability & Evaluation

- **Traces:** `daemon.log` already records both signals: `sqlite_stmt_slow` lines for this SQL,
  and `event_loop_stall`. Baseline: 265 slow ledger scans (135 s) and 342 stalls (480 s) in the hour
  before either change shipped, 2026-10-30.
- **Eval:** `ladder.test.ts`: after migration the index exists with this exact predicate, and the
  urgent arm's plan seeks it.
- **Experiment:** compare the hour after deploy with the baseline. Falsify: slow ledger-scan lines
  above 10% of the baseline count, or no fall in the share of gate hooks ending "unenforced (gate
  unreachable)".
