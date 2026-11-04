import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../db/migrations.js';
import { compareInventories, EPHEMERAL_TABLES, rowsOnlyIn, takeInventory } from './inventory.js';

/** A migrated store with a few rows in the tables the move cares about. */
function seeded(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    "INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('t1', 'revive', 1, 1)",
  ).run();
  db.prepare(
    "INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('n-hub', 't1', 'mac.lan', 4)",
  ).run();
  db.prepare("INSERT INTO local_node (team_id, node_id) VALUES ('t1', 'n-hub')").run();
  const log = db.prepare(
    `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
     VALUES (?, 't1', 'n-hub', ?, ?, '{}', 1)`,
  );
  for (let i = 1; i <= 3; i++) log.run(`e${i}`, i, i);
  db.prepare(
    "INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at) VALUES ('a1', 't1', 1, 'nick', 'x', 'y', 'allow', '{\"a\":1}', 1)",
  ).run();
  return db;
}

function copyOf(db: Database.Database): Database.Database {
  return new Database(db.serialize());
}

describe('the hub inventory (ADR 796)', () => {
  it('matchesAByteCopy', () => {
    const a = seeded();
    expect(compareInventories(takeInventory(a), takeInventory(copyOf(a)))).toEqual([]);
  });

  it('namesACountMismatch', () => {
    const a = seeded();
    const b = copyOf(a);
    b.prepare("DELETE FROM sync_log WHERE id = 'e3'").run();
    const diff = compareInventories(takeInventory(a), takeInventory(b));
    expect(diff).toEqual([expect.objectContaining({ table: 'sync_log', kind: 'count' })]);
  });

  it('namesADigestMismatch', () => {
    const a = seeded();
    const b = copyOf(a);
    b.prepare('UPDATE audit SET detail = \'{"a":2}\'').run();
    expect(compareInventories(takeInventory(a), takeInventory(b))).toEqual([
      expect.objectContaining({ table: 'audit', kind: 'digest' }),
    ]);
  });

  it('reportsOutboxPending: what a syncing node stamped and has not pushed', () => {
    const a = seeded();
    const inv = takeInventory(a);
    expect(inv.sync.hub_seq).toBe(3);
    expect(inv.sync.origins).toEqual({ 'n-hub': 3 });
    // A hub: seqs 1..3 stamped and all three in its own log, so nothing is pending.
    expect(inv.outbox_pending).toBe(0);
    // A joiner that stamped two more and pushed only up to 4.
    a.prepare("UPDATE nodes SET next_seq = 6 WHERE id = 'n-hub'").run();
    a.prepare(
      "INSERT INTO sync_push_cursor (team_id, node_id, last_seq, updated_at) VALUES ('t1', 'n-hub', 4, 1)",
    ).run();
    expect(takeInventory(a).outbox_pending).toBe(1);
    // A single-machine team never pushes and never counts.
    a.prepare(
      "INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('t2', 'solo', 1, 1)",
    ).run();
    a.prepare(
      "INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('n-solo', 't2', 'mac.lan', 50)",
    ).run();
    a.prepare("INSERT INTO local_node (team_id, node_id) VALUES ('t2', 'n-solo')").run();
    expect(takeInventory(a).outbox_pending).toBe(1);
  });

  it('listsRowsOnlyInTheReplica', () => {
    const hub = seeded();
    const replica = copyOf(hub);
    replica
      .prepare(
        "INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at) VALUES ('a2', 't1', 2, 'ryder', 'box-only', 'z', 'allow', '{}', 2)",
      )
      .run();
    const only = rowsOnlyIn(replica, hub, 'audit');
    expect(only).toHaveLength(1);
    expect(rowsOnlyIn(hub, replica, 'audit')).toEqual([]);
  });

  it('ignoresEphemeralTables', () => {
    const a = seeded();
    const b = copyOf(a);
    b.prepare("UPDATE nodes SET last_seen_at = 99 WHERE id = 'n-hub'").run();
    expect(EPHEMERAL_TABLES).toContain('presence');
    // A liveness stamp is not data: nodes.last_seen_at is excluded from the digest.
    expect(
      compareInventories(takeInventory(a), takeInventory(b), { ignore: EPHEMERAL_TABLES }),
    ).toEqual([]);
  });
});
