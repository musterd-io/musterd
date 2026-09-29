// Q3 of the PGlite spike: the smallest async interface both engines can sit behind. Spike-only.
import { createRequire } from 'node:module';
import { PGlite } from '@electric-sql/pglite';
import { toPgPlaceholders } from '../pglite-hookpath.mjs';
import { sqliteToPostgres } from '../pglite-schema.mjs';

const Database = createRequire(new URL('../../../packages/server/package.json', import.meta.url))(
  'better-sqlite3',
);

/**
 * @typedef {object} Driver
 * @property {(sql: string, params: unknown[]) => Promise<any>} get
 * @property {(sql: string, params: unknown[]) => Promise<any[]>} all
 * @property {(sql: string, params: unknown[]) => Promise<{changes: number}>} run
 * @property {(sql: string) => Promise<void>} exec
 * @property {<T>(fn: (d: Driver) => Promise<T>) => Promise<T>} tx
 * @property {() => Promise<void>} close
 */

export function sqliteDriver(path) {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  const d = {
    async get(sql, params) {
      return db.prepare(sql).get(...params);
    },
    async all(sql, params) {
      return db.prepare(sql).all(...params);
    },
    async run(sql, params) {
      return { changes: db.prepare(sql).run(...params).changes };
    },
    async exec(sql) {
      db.exec(sql);
    },
    // better-sqlite3 transactions are synchronous; an async body cannot be wrapped in db.transaction.
    // BEGIN/COMMIT by hand keeps the same call shape as PGlite — but it is NOT equivalent to
    // today's db.transaction(fn): every `await` in the body yields the event loop, so another
    // request's statements can run inside this open transaction on the same connection, and a
    // second tx() would hit "cannot start a transaction within a transaction". A real driver needs
    // a transaction queue (one tx at a time; the next waits) or a rule that transaction bodies
    // stay synchronous (review I5). The spike serialises tests, so it never hits it.
    async tx(fn) {
      db.exec('BEGIN');
      try {
        const r = await fn(d);
        db.exec('COMMIT');
        return r;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async close() {
      db.close();
    },
  };
  return d;
}

export async function pgliteDriver(dataDir) {
  const pg = dataDir ? new PGlite(dataDir) : new PGlite();
  await pg.waitReady;
  const prep = (sql) => toPgPlaceholders(sqliteToPostgres(sql));
  const wrap = (q) => ({
    async get(sql, params) {
      return (await q.query(prep(sql), params)).rows[0];
    },
    async all(sql, params) {
      return (await q.query(prep(sql), params)).rows;
    },
    async run(sql, params) {
      return { changes: (await q.query(prep(sql), params)).affectedRows ?? 0 };
    },
    async exec(sql) {
      await q.exec(prep(sql));
    },
  });
  const d = {
    ...wrap(pg),
    async tx(fn) {
      return pg.transaction((t) =>
        fn({
          ...wrap(t),
          tx: () => {
            throw new Error('nested tx');
          },
          close: async () => {},
        }),
      );
    },
    async close() {
      await pg.close();
    },
  };
  return d;
}
