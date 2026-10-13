import { expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';

/**
 * The open-directed ledger's thread lookups must seek, not scan (lane 01M4S7GW7P). On the Air's 23k
 * messages SQLite answered `act = 'resolve' AND thread_id = ? ORDER BY ts LIMIT 1` by walking the
 * team's `(team_id, ts)` index to skip the sort — 305 calls, ~8.5 s of a 22 s cold /report. SQLite's
 * planner is the only one with that habit, so this is a SQLite-plan test; Postgres runs the same SQL
 * off the same ladder and has no plan to pin here.
 */
withDrivers('ledger lookup plans', (open, kind) => {
  it.skipIf(kind !== 'sqlite')(
    'the earliest-resolve-in-thread lookup uses the (team, act, thread, ts) index',
    async () => {
      const db = await open();
      const plan = await db.all<{ detail: string }>(
        "EXPLAIN QUERY PLAN SELECT id, ts FROM messages WHERE team_id = 't' AND act = 'resolve' AND thread_id = 'x' ORDER BY ts ASC LIMIT 1",
      );
      expect(plan.map((r) => r.detail).join(' | ')).toContain('idx_messages_thread_act_ts');
    },
  );
});
