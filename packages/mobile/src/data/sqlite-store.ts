import type { CalendarEntry } from '@musterd/protocol/calendar';
import * as SQLite from 'expo-sqlite';
import type { LocalStore, PendingWrite } from '../lib/sync';

/**
 * The device copy of the calendar in SQLite (ADR 520 §4) — the `LocalStore` the sync logic runs
 * against. Entries are stored as their wire JSON: the daemon's schema is the schema, and the phone
 * never reads a column the protocol does not define.
 */

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY NOT NULL, json TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS pending (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    op TEXT NOT NULL,
    body TEXT,
    base INTEGER
  );
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL);
`;

interface PendingRow {
  seq: number;
  id: string;
  op: PendingWrite['op'];
  body: string | null;
  base: number | null;
}

function toPending(r: PendingRow): PendingWrite {
  return {
    seq: r.seq,
    id: r.id,
    op: r.op,
    body: r.body === null ? null : JSON.parse(r.body),
    base: r.base,
  } as PendingWrite;
}

export async function openSqliteStore(name = 'calendar.db'): Promise<LocalStore> {
  const db = await SQLite.openDatabaseAsync(name);
  await db.execAsync(SCHEMA);

  return {
    async entries() {
      const rows = await db.getAllAsync<{ json: string }>('SELECT json FROM entries');
      return rows.map((r) => JSON.parse(r.json) as CalendarEntry);
    },
    async putEntries(entries) {
      if (entries.length === 0) return;
      await db.withTransactionAsync(async () => {
        for (const e of entries) {
          await db.runAsync(
            'INSERT OR REPLACE INTO entries (id, json) VALUES (?, ?)',
            e.id,
            JSON.stringify(e),
          );
        }
      });
    },
    async deleteEntries(ids) {
      if (ids.length === 0) return;
      await db.withTransactionAsync(async () => {
        for (const id of ids) await db.runAsync('DELETE FROM entries WHERE id = ?', id);
      });
    },
    async cursor() {
      const row = await db.getFirstAsync<{ value: string }>(
        "SELECT value FROM meta WHERE key = 'cursor'",
      );
      return row ? Number(row.value) : null;
    },
    async setCursor(cursor) {
      if (cursor === null) await db.runAsync("DELETE FROM meta WHERE key = 'cursor'");
      else
        await db.runAsync(
          "INSERT OR REPLACE INTO meta (key, value) VALUES ('cursor', ?)",
          String(cursor),
        );
    },
    async pending() {
      const rows = await db.getAllAsync<PendingRow>(
        'SELECT seq, id, op, body, base FROM pending ORDER BY seq',
      );
      return rows.map(toPending);
    },
    async addPending(w) {
      await db.runAsync(
        'INSERT INTO pending (id, op, body, base) VALUES (?, ?, ?, ?)',
        w.id,
        w.op,
        w.body === null ? null : JSON.stringify(w.body),
        w.base,
      );
    },
    async updatePending(w) {
      await db.runAsync(
        'UPDATE pending SET id = ?, op = ?, body = ?, base = ? WHERE seq = ?',
        w.id,
        w.op,
        w.body === null ? null : JSON.stringify(w.body),
        w.base,
        w.seq,
      );
    },
    async deletePending(seq) {
      await db.runAsync('DELETE FROM pending WHERE seq = ?', seq);
    },
  };
}
