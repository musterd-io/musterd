import { describe } from 'vitest';
import type { Driver } from './driver.js';
import { openDb } from './open.js';
import { migratePostgres, migrateTracePostgres } from './pg/migrate.js';
import { pgDriver, type PgDriver, type PoolFactory } from './pgDriver.js';
import { pgliteDriver, type PgliteDriver } from './pgliteDriver.js';
import { sqliteDriver } from './sqliteDriver.js';
import { openTraceDriver } from './traceDb.js';

/**
 * `pg` is the third kind: REAL Postgres, from `~/.musterd/cloud/neon.env` (the Neon pass,
 * `scripts/cloud/neon-pass.mjs`). Never the default and never in CI — it needs the env file; a
 * `MUSTERD_TEST_DRIVER=pg` run without one fails at the first open.
 */
export type DriverKind = 'sqlite' | 'pglite' | 'pg';

/**
 * Which drivers a `withDrivers` block runs on. MUSTERD_TEST_DRIVER=sqlite|pglite|both; the default
 * is `both` (ADR 479 §3: a Cloud-only bug must fail the suite, not wait for a deploy). `sqlite`
 * is the fast local loop; `pglite` alone reproduces a Postgres-side failure.
 */
export function testDriverKinds(): DriverKind[] {
  const env = process.env['MUSTERD_TEST_DRIVER'];
  if (env === 'pglite') return ['pglite'];
  if (env === 'sqlite') return ['sqlite'];
  if (env === 'pg') return ['pg'];
  return ['sqlite', 'pglite'];
}

export type TestStore = 'main' | 'trace';

// One migrated PGlite per worker per store; each openTestDriver('pglite') truncates everything
// (~0.5 s/file). The trace store is its own instance, as it is its own database in Cloud.
// `instance` is for a test that boots TWO daemons (a hub and a joiner): two handles on one PGlite
// would share every table, so the second daemon gets its own instance.
const pooled: Record<string, Promise<{ d: PgliteDriver; tables: string[] }>> = {};
function pooledPglite(store: TestStore, instance = 'a') {
  const key = `${store}:${instance}`;
  let p = pooled[key];
  if (!p) {
    p = pooled[key] = (async () => {
      const d = await pgliteDriver();
      const owner = d.asOwner();
      await (store === 'trace' ? migrateTracePostgres(owner) : migratePostgres(owner));
      // Everything but schema_meta is truncated between tests: the version row is the schema's,
      // not a test's, and /health reads it.
      const tables = (
        await owner.all<{ table_name: string }>(
          "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_meta'",
        )
      ).map((r) => r.table_name);
      return { d, tables };
    })();
  }
  return p;
}

/**
 * A fresh, migrated, empty store. On PGlite the handle is OPERATOR-scoped (spec §12.1): a test
 * seeds whichever teams it likes and reads them all back; a tenant-scoped view is
 * `.forTeam(id)` on it, exactly as the auth seam does in the server. `{ team }` asks for that
 * tenant-scoped handle directly; `{ store: 'trace' }` opens the trace store (ADR 445 §3) instead;
 * `{ instance: 'b' }` a second, separate PGlite for a test that runs two daemons.
 */
export async function openTestDriver(
  kind: DriverKind,
  opts: { team?: string; store?: TestStore; instance?: string } = {},
): Promise<Driver> {
  const store = opts.store ?? 'main';
  if (kind === 'sqlite')
    return store === 'trace' ? openTraceDriver(':memory:') : sqliteDriver(openDb(':memory:'));
  const { d, tables } =
    kind === 'pg' ? await realPostgres(store) : await pooledPglite(store, opts.instance);
  // RESTART IDENTITY: a fresh slate numbers row_seq from 1, as a fresh SQLite file does rowid.
  const owner = d.asOwner();
  // Real Postgres (the Neon pass) is ONE database across tests: the previous test's deferred writes
  // (a notification's `.then`) can still be in flight. Let them settle, and retry a deadlocked
  // TRUNCATE rather than fail the next test for the last one's tail. The double needs neither.
  if (kind === 'pg') {
    await new Promise((r) => setTimeout(r, 250));
    for (let i = 0; ; i++) {
      try {
        await owner.exec(
          `TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`,
        );
        break;
      } catch (e) {
        if (i >= 4 || !/deadlock/i.test(String(e))) throw e;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  } else
    await owner.exec(`TRUNCATE ${tables.map((t) => `"${t}"`).join(', ')} RESTART IDENTITY CASCADE`);
  // schema_meta keeps only the schema's own row; a test's marks (corpus watermarks, sync keys) go.
  await owner.exec("DELETE FROM schema_meta WHERE key <> 'schema_version'");
  const scoped = opts.team !== undefined ? d.forTeam(opts.team) : d.asOperator();
  // A test's close() must not close the pooled instance.
  return { ...scoped, close: async () => undefined };
}

// The real-Postgres kind: one driver per store from the env file, already migrated by the pass
// script (this never runs DDL against Neon); every open truncates as the owner, like the double.
const real: Partial<Record<TestStore, Promise<{ d: PgDriver; tables: string[] }>>> = {};
function realPostgres(store: TestStore) {
  let p = real[store];
  if (!p) {
    p = real[store] = (async () => {
      const { readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const env: Record<string, string> = {};
      for (const line of readFileSync(
        join(homedir(), '.musterd', 'cloud', 'neon.env'),
        'utf8',
      ).split('\n')) {
        const m = /^([A-Z_]+)=(?:'([^']*)'|"([^"]*)"|(.*))$/.exec(line.trim());
        if (m) env[m[1]!] = m[2] ?? m[3] ?? m[4] ?? '';
      }
      const url = (k: string) => {
        const u = new URL(env[k]!);
        if (store === 'trace') u.pathname = `${u.pathname}_trace`;
        return u.toString();
      };
      const d = pgDriver({
        appUrl: url('DATABASE_APP_URL'),
        operatorUrl: url('DATABASE_OPERATOR_URL'),
        ownerUrl: url('DATABASE_OWNER_URL'),
        poolSize: 3,
      });
      const tables = (
        await d.asOwner().all<{
          table_name: string;
        }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> 'schema_meta'")
      ).map((r) => r.table_name);
      return { d, tables };
    })();
  }
  return p;
}

/**
 * Pools for a cloud-mode server (1C): `createServer({ cloudPools })` runs the production `pgDriver`
 * over the pooled PGlite instances, so the cloud path is exercised end to end without a network.
 * Truncation is the caller's: open the seed handle(s) with `openTestDriver('pglite')` FIRST — that
 * is what empties the instance. `urls` records every URL the driver asked a pool for.
 */
export async function testCloudPools(): Promise<{
  factories: { main: PoolFactory; trace: PoolFactory };
  urls: string[];
}> {
  const urls: string[] = [];
  const logged =
    (f: PoolFactory): PoolFactory =>
    (url) => {
      urls.push(url);
      return f(url);
    };
  const main = (await pooledPglite('main')).d.poolFactory();
  const trace = (await pooledPglite('trace')).d.poolFactory();
  return { factories: { main: logged(main), trace: logged(trace) }, urls };
}

export function withDrivers(
  name: string,
  fn: (open: () => Promise<Driver>, kind: DriverKind) => void,
): void {
  describe.each(testDriverKinds())(`${name} [%s]`, (kind) => {
    fn(() => openTestDriver(kind), kind);
  });
}
