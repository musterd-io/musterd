import type Database from 'better-sqlite3';
import { describe } from 'vitest';
import type { Driver } from './driver.js';
import { openDb } from './open.js';
import { pgliteDriver } from './pgliteDriver.js';
import { loadPgSchema } from './pgSchema.js';
import { sqliteDriver, type SqliteDriver } from './sqliteDriver.js';
import { openTraceDb } from './traceDb.js';

export type DriverKind = 'sqlite' | 'pglite';

/**
 * Which drivers a `withDrivers` block runs on. MUSTERD_TEST_DRIVER=sqlite|pglite|both; the default
 * is `both` (ADR 479 §3: a Cloud-only bug must fail the suite, not wait for a deploy). `sqlite`
 * is the fast local loop; `pglite` alone reproduces a Postgres-side failure.
 */
export function testDriverKinds(): DriverKind[] {
  const env = process.env['MUSTERD_TEST_DRIVER'];
  if (env === 'pglite') return ['pglite'];
  if (env === 'sqlite') return ['sqlite'];
  return ['sqlite', 'pglite'];
}

// One migrated PGlite per worker; each openTestDriver('pglite') truncates everything (~0.5 s/file).
let pooled: Promise<{ d: Driver; tables: string[] }> | null = null;
function pooledPglite() {
  if (!pooled) {
    pooled = (async () => {
      const d = await pgliteDriver();
      await loadPgSchema(d);
      const tables = (
        await d.all<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
        )
      ).map((r) => r.table_name);
      return { d, tables };
    })();
  }
  return pooled;
}

export async function openTestDriver(kind: DriverKind): Promise<Driver> {
  if (kind === 'sqlite') return sqliteDriver(openDb(':memory:'));
  const { d, tables } = await pooledPglite();
  await d.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} CASCADE`);
  // A test's close() must not close the pooled instance.
  return { ...d, close: async () => undefined };
}

export function withDrivers(
  name: string,
  fn: (open: () => Promise<Driver>, kind: DriverKind) => void,
): void {
  describe.each(testDriverKinds())(`${name} [%s]`, (kind) => {
    fn(() => openTestDriver(kind), kind);
  });
}

/**
 * TRANSITION (plan 1A; Task 24 replaces every use with `withDrivers`): a handle that is a
 * SqliteDriver AND forwards better-sqlite3's own surface (`prepare`, `pragma`, `transaction`,
 * `close`, `name`, `memory`, …), so a test written against the raw handle keeps working while the
 * functions it calls take a Driver. `exec` runs synchronously here on purpose — tests run
 * `db.exec('DROP TABLE x')` without awaiting and continue — and returns a resolved promise so the
 * Driver contract holds too.
 */
export type TestDb = SqliteDriver & Database.Database;

function hybrid(raw: Database.Database): TestDb {
  const d = sqliteDriver(raw);
  return new Proxy(d as unknown as TestDb, {
    get(_t, prop) {
      if (prop === 'exec') {
        return (sql: string) => {
          raw.exec(sql);
          return Promise.resolve();
        };
      }
      if (prop in d) {
        const v = (d as unknown as Record<PropertyKey, unknown>)[prop];
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(d) : v;
      }
      const v = (raw as unknown as Record<PropertyKey, unknown>)[prop];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(raw) : v;
    },
  });
}

export function openTestDb(path = ':memory:'): TestDb {
  return hybrid(openDb(path));
}

export function openTestTraceDb(path = ':memory:'): TestDb {
  return hybrid(openTraceDb(path));
}
