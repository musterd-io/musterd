import { expect, it } from 'vitest';
import { withDrivers } from '../db/testing.js';
import { WAKE_AUDIT_SQL, WAKE_LEASED_SQL } from './insights.js';
import { listInterruptCandidates } from './interruptCandidates.js';
import { INBOX_AFTER_CURSOR_SQL } from './messages.js';
import { OWED_REVIEWS_SQL } from './orientation.js';

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
  it.skipIf(kind !== 'sqlite')(
    'the wake-lease read seeks (team, action, ts) (ADR 749)',
    async () => {
      const db = await open();
      const plan = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${WAKE_LEASED_SQL}`, [
        't',
        0,
      ]);
      expect(plan.map((r) => r.detail).join(' | ')).toContain('idx_audit_team_action_ts');
    },
  );
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

withDrivers('inbox count plans', (open, kind) => {
  // Lane 01M5G9FKCG: the inbox counts filter on columns `(team_id, created_at)` does not carry, so each
  // count fetched every message row since its floor — on the hub, rows that do not stay cached. The
  // covering index answers all three shapes without touching the table.
  it.skipIf(kind !== 'sqlite')(
    'countInbox and both countUnread shapes read only the covering index',
    async () => {
      const db = await open();
      const base =
        "SELECT COUNT(*) AS n FROM messages WHERE team_id = 't' AND (to_member = 'm' OR to_kind IN ('team','broadcast')) AND from_member != 'm'";
      for (const sql of [
        base,
        `${base} AND created_at > 1`,
        `${base} AND (created_at > 1 OR (created_at = 1 AND id > 'x'))`,
      ]) {
        const plan = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`);
        expect(plan.map((r) => r.detail).join(' | ')).toContain(
          'COVERING INDEX idx_messages_inbox_cover',
        );
      }
    },
  );
});

withDrivers('owed reviews plan', (open, kind) => {
  // ADR 778's re-read (2026-11-02, lane 01M6EV84VH): with `l.id = json_extract(...)` the TEXT
  // column's affinity kept SQLite off `idx_messages_lane_review`, so every orientation walked all
  // messages addressed to the seat — 611 slow runs, 374 s in four daytime hours on the hub. The plan
  // depends on statistics, so the store is shaped like a hub (most lanes closed, a seat that
  // receives far more messages than it owes reviews) and analyzed, as the ladder does on boot.
  it.skipIf(kind !== 'sqlite')('the owed-reviews read seeks the lane_review index', async () => {
    const db = await open();
    await db.run('PRAGMA foreign_keys = OFF');
    for (const id of ['m0', 'm1'])
      await db.run(
        "INSERT INTO members (id, team_id, name, kind, created_at, updated_at) VALUES (?, 't', ?, 'agent', 0, 0)",
        [id, id === 'm0' ? 'seat' : 'other'],
      );
    for (let i = 0; i < 300; i++)
      await db.run(
        "INSERT INTO lanes (id, team_id, project, title, state, owner_seat, created_by, created_at, updated_at) VALUES (?, 't', 'p', 'x', ?, 'other', 'other', ?, ?)",
        [`L${i}`, i < 3 ? 'awaiting_acceptance' : 'done', i, i],
      );
    for (let i = 0; i < 2000; i++) {
      const ask = i % 20 === 0;
      await db.run(
        "INSERT INTO messages (id, team_id, from_member, to_member, to_kind, act, body, meta, ts, created_at) VALUES (?, 't', 'm1', 'm0', 'member', ?, 'b', ?, ?, ?)",
        [
          `M${i}`,
          ask ? 'ask' : 'message',
          ask ? JSON.stringify({ lane_review: { lane: `L${i % 300}` } }) : null,
          i,
          i,
        ],
      );
    }
    await db.run('ANALYZE');
    const plan = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${OWED_REVIEWS_SQL}`, [
      't',
      'seat',
      'seat',
    ]);
    expect(plan.map((r) => r.detail).join(' | ')).toContain('idx_messages_lane_review');
  });
});

withDrivers('interrupt window plan', (open, kind) => {
  // After #3729 the interrupt window read was the hub's top slow statement (875 runs, 359 s in four
  // hours, lane 01M6EV84VH): a stale cursor widens the window to INTERRUPT_LOOKBACK_MS and the read
  // fetched every row in it to test the text guard. v139's partial index holds only the rows that
  // pass the guard, both seams must keep using it, and the idle seam's directed branch must seek
  // too. The SQL is built inside the function, so a driver wrapper records it and the test explains
  // what was actually sent.
  for (const directed of [false, true])
    it.skipIf(kind !== 'sqlite')(
      `the ${directed ? 'idle' : 'boundary'} seam reads the interrupt-window index`,
      async () => {
        const db = await open();
        await db.run('PRAGMA foreign_keys = OFF');
        for (const id of ['m0', 'm1'])
          await db.run(
            "INSERT INTO members (id, team_id, name, kind, created_at, updated_at) VALUES (?, 't', ?, 'agent', 0, 0)",
            [id, id],
          );
        // Shaped like a hub: most rows are team-wide lane chatter the guard drops.
        for (let i = 0; i < 2000; i++) {
          const guard = i % 10 === 0;
          await db.run(
            "INSERT INTO messages (id, team_id, from_member, to_member, to_kind, act, body, meta, ts, created_at) VALUES (?, 't', 'm1', ?, ?, ?, 'b', ?, ?, ?)",
            [
              `M${String(i).padStart(5, '0')}`,
              guard ? 'm0' : null,
              guard ? 'member' : 'team',
              guard ? 'steer' : 'message',
              JSON.stringify({ lane: `L${i}` }),
              i,
              i,
            ],
          );
        }
        await db.run('ANALYZE');
        const sent: { sql: string; params: unknown[] }[] = [];
        const spy = new Proxy(db, {
          get(target, prop, receiver) {
            if (prop === 'all')
              return (sql: string, params: unknown[] = []) => {
                sent.push({ sql, params });
                return target.all(sql, params);
              };
            return Reflect.get(target, prop, receiver) as unknown;
          },
        });
        await listInterruptCandidates(
          spy,
          { id: 'm0', team_id: 't', name: 'm0' },
          { directed, now: 0 },
        );
        const window = sent.find((s) => s.sql.includes("to_kind IN ('team','broadcast')"));
        expect(window).toBeDefined();
        const plan = await db.all<{ detail: string }>(
          `EXPLAIN QUERY PLAN ${window!.sql}`,
          window!.params,
        );
        const detail = plan.map((r) => r.detail).join(' | ');
        expect(detail).toContain('idx_messages_interrupt_window');
        expect(detail).not.toMatch(/SCAN messages/);
      },
    );
});

withDrivers('inbox cursor plan', (open, kind) => {
  // Lane 01M6J3ERC4: the `(created_at, id)` cursor spelled as `created_at > ? OR (created_at = ? AND
  // id > ?)` stopped idx_messages_inbox_cover at the team, so every unread first page walked the
  // team's whole history from its oldest row — 854 slow runs, 669 s, max 3.6 s on the laptop hub
  // 2026-11-03 18:22Z–02:10Z. INBOX_AFTER_CURSOR_SQL carries a redundant `created_at >= ?` the
  // planner can seek on.
  it.skipIf(kind !== 'sqlite')(
    'the unread inbox read after a cursor seeks (team, created_at)',
    async () => {
      const db = await open();
      const where = `WHERE team_id = 't' AND (to_member = 'm' OR to_kind IN ('team','broadcast')) AND from_member != 'm' AND ${INBOX_AFTER_CURSOR_SQL}`;
      for (const sql of [
        `SELECT * FROM messages ${where} ORDER BY created_at ASC, id ASC LIMIT 200`,
        `SELECT COUNT(*) AS n FROM messages ${where}`,
      ]) {
        const plan = await db.all<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, [1, 1, 1, 'x']);
        expect(plan.map((r) => r.detail).join(' | ')).toContain('created_at>?');
      }
    },
  );
});
