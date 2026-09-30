import type { PGlite, Transaction } from '@electric-sql/pglite';
import { toPostgres } from './dialect.js';
import { DriverError, type Driver, type Params } from './driver.js';

/**
 * PGlite behind the async Driver — the Postgres test double (ADR 479 §1/§3). Not a runtime import
 * anywhere: only tests and plan-1B tooling reach this file (noPgliteInDist.test greps the bundle for
 * the package name). BIGINT (oid 20) parses to a JS number: every epoch-millis column is compared
 * and subtracted as a number by the modules, and none of them is near 2^53.
 */
export async function pgliteDriver(opts: { dataDir?: string } = {}): Promise<Driver> {
  const { PGlite: PG } = await import('@electric-sql/pglite');
  const pg: PGlite = new PG(opts.dataDir, { parsers: { 20: (v: string) => Number(v) } });
  await pg.waitReady;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new DriverError('driver is closed', 'closed');
  };
  // Postgres names the column, never the statement; a test double that hides which of a module's
  // statements failed would send every dialect bug on a hunt, so the SQL rides on the error.
  const query = async <R>(q: PGlite | Transaction, sql: string, params: Params) => {
    const pgSql = toPostgres(sql);
    try {
      return await q.query<R>(pgSql, params as unknown[]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${msg}\n  in: ${pgSql.replace(/\s+/g, ' ').trim()}`, { cause: e });
    }
  };
  const wrap = (q: PGlite | Transaction, depth: number): Driver => ({
    dialect: 'postgres',
    async get<R>(sql: string, params: Params = []) {
      assertOpen();
      return (await query<R>(q, sql, params)).rows[0];
    },
    async all<R>(sql: string, params: Params = []) {
      assertOpen();
      return (await query<R>(q, sql, params)).rows;
    },
    async run(sql: string, params: Params = []) {
      assertOpen();
      return { changes: (await query(q, sql, params)).affectedRows ?? 0 };
    },
    async exec(sql: string) {
      assertOpen();
      await q.exec(toPostgres(sql));
    },
    async tx<T>(fn: (t: Driver) => Promise<T>): Promise<T> {
      assertOpen();
      if (depth === 0) return pg.transaction((t) => fn(wrap(t, 1)));
      const name = `sp${depth}`;
      await q.exec(`SAVEPOINT ${name}`);
      try {
        const r = await fn(wrap(q, depth + 1));
        await q.exec(`RELEASE ${name}`);
        return r;
      } catch (e) {
        await q.exec(`ROLLBACK TO ${name}`);
        await q.exec(`RELEASE ${name}`);
        throw e;
      }
    },
    connection() {
      return root;
    },
    async close() {
      if (depth > 0) return;
      closed = true;
      await pg.close();
    },
  });
  const root: Driver = wrap(pg, 0);
  return root;
}
