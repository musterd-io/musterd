import { expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { WAKE_AUDIT_SQL } from './insights.js';

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

withDrivers('report wake-metrics plan', (open, kind) => {
  // Lane 01M4VYH20W: with `ORDER BY ts` SQLite walked `(team_id, ts)` and read every audit row of the
  // team in the 7-day window — 163,001 on the hub to keep 5,428, 1.4 s cold — on every cold /report.
  it.skipIf(kind !== 'sqlite')('the wake-metrics audit read seeks (team, action, ts)', async () => {
    const db = await open();
    const plan = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${WAKE_AUDIT_SQL}`, ['t', 0]);
    expect(plan.map((r) => r.detail).join(' | ')).toContain('idx_audit_team_action_ts');
  });
});

withDrivers('lane history plan', (open, kind) => {
  // Lane 01M5G7KWJP: `action LIKE 'lane.%'` stops the action indexes at the team, so with no index on
  // `target` the read walked every audit row of the team — 306,790 on the revive hub, 3.9 s cold — on
  // every `GET /lanes/:id`, each a synchronous stall of the daemon's event loop.
  it.skipIf(kind !== 'sqlite')('one lane’s history seeks (team, target, ts)', async () => {
    const db = await open();
    const plan = await db.all<{ detail: string }>(
      "EXPLAIN QUERY PLAN SELECT ts, action FROM audit WHERE team_id = 't' AND action LIKE 'lane.%' AND target = 'L' ORDER BY ts DESC, id DESC LIMIT 200",
    );
    expect(plan.map((r) => r.detail).join(' | ')).toContain('idx_audit_team_target_ts');
  });
});
