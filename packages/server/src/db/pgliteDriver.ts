import type { PGlite, Transaction } from '@electric-sql/pglite';
import { toPostgres } from './dialect.js';
import { DriverError, type Driver, type Params } from './driver.js';
import { ROLE, TENANT_SETTING } from './pg/tenancy.js';
import type { Client, PoolFactory } from './pgDriver.js';

/**
 * PGlite behind the async Driver — the Postgres test double (ADR 479 §1/§3). Not a runtime import
 * anywhere: only tests and plan-1B tooling reach this file (noPgliteInDist.test greps the bundle for
 * the package name). BIGINT (oid 20) parses to a JS number: every epoch-millis column is compared
 * and subtracted as a number by the modules, and none of them is near 2^53.
 *
 * Tenancy (spec §12.1) is modelled exactly as `pgDriver.ts` does it: every statement runs inside a
 * transaction stamped `SET LOCAL ROLE <role>` and, on a team handle, `set_config('app.team_id')`.
 * The root handle is the app role with no tenant — fail-closed, it sees no team-owned row.
 * `forTeam` / `asOperator` are the Driver's seam; `asOwner` is the double's owner path (the
 * superuser connection, no SET ROLE) for `migratePostgres` and DDL fixtures. `exec` always runs on
 * that owner path: it is the DDL/TRUNCATE verb, and in the double the owner is the connection.
 */
export interface PgliteDriver extends Driver {
  /** The owner-scoped handle: what `migratePostgres` takes. Test double only. */
  asOwner(): Driver;
  /** Observe every statement (the SqliteDriver seam), so a query-shape count runs on both engines. */
  onStatement(listener: (sql: string) => void): () => void;
  /**
   * This PGlite as a `pgDriver` pool (1C): so a test can run the REAL production driver — its
   * BEGIN / SET LOCAL ROLE / set_config / COMMIT choreography — against the double's schema and
   * RLS. Each `connect()` holds PGlite's own transaction lock until `release()`, so a client's
   * statements are never interleaved with another's; the URL is ignored (one database), and
   * `end()` never closes the shared instance.
   */
  poolFactory(): PoolFactory;
}

type Scope = { role: 'owner' | 'app' | 'operator'; team: string | null };

export async function pgliteDriver(opts: { dataDir?: string } = {}): Promise<PgliteDriver> {
  const { PGlite: PG } = await import('@electric-sql/pglite');
  const pg: PGlite = new PG(opts.dataDir, { parsers: { 20: (v: string) => Number(v) } });
  await pg.waitReady;
  let closed = false;
  const assertOpen = () => {
    if (closed) throw new DriverError('driver is closed', 'closed');
  };
  const listeners = new Set<(sql: string) => void>();
  const notify = (sql: string) => {
    for (const l of listeners) l(sql);
  };
  // Postgres names the column, never the statement; a test double that hides which of a module's
  // statements failed would send every dialect bug on a hunt, so the SQL rides on the error.
  const query = async <R>(q: PGlite | Transaction, sql: string, params: Params) => {
    notify(sql);
    const pgSql = toPostgres(sql);
    try {
      return await q.query<R>(pgSql, params as unknown[]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`${msg}\n  in: ${pgSql.replace(/\s+/g, ' ').trim()}`, { cause: e });
    }
  };
  const stamp = async (t: Transaction, s: Scope) => {
    if (s.role === 'owner') return;
    await t.exec(`SET LOCAL ROLE ${s.role === 'app' ? ROLE.app : ROLE.operator}`);
    if (s.team !== null)
      await t.query(`SELECT set_config('${TENANT_SETTING}', $1, true)`, [s.team]);
  };
  const noRescope = (what: string) =>
    new DriverError(
      `scope is fixed for the transaction; call ${what} on the connection handle`,
      'no_tenant_scope',
    );
  // Connection handles are memoised per scope (as pgDriver does): a cache keyed on the Driver
  // object must see one handle per team.
  const scoped = new Map<string, PgliteDriver>();
  const connection = (scope: Scope): PgliteDriver => {
    const key = `${scope.role}:${scope.team ?? ''}`;
    let h = scoped.get(key);
    if (!h) scoped.set(key, (h = wrap(pg, 0, scope)));
    return h;
  };
  // depth 0 = a connection handle (each statement is its own stamped transaction); depth ≥ 1 = a
  // handle bound to the open transaction `q`, already stamped.
  const wrap = (q: PGlite | Transaction, depth: number, scope: Scope): PgliteDriver => {
    const one = <R>(fn: (t: PGlite | Transaction) => Promise<R>): Promise<R> =>
      depth === 0
        ? pg.transaction(async (t) => {
            await stamp(t, scope);
            return fn(t);
          })
        : fn(q);
    return {
      dialect: 'postgres',
      async get<R>(sql: string, params: Params = []) {
        assertOpen();
        return one(async (t) => (await query<R>(t, sql, params)).rows[0]);
      },
      async all<R>(sql: string, params: Params = []) {
        assertOpen();
        return one(async (t) => (await query<R>(t, sql, params)).rows);
      },
      async run(sql: string, params: Params = []) {
        assertOpen();
        return one(async (t) => ({ changes: (await query(t, sql, params)).affectedRows ?? 0 }));
      },
      async exec(sql: string) {
        assertOpen();
        notify(sql);
        // The owner path: DDL and TRUNCATE on the superuser connection (or inside the open tx).
        await q.exec(toPostgres(sql));
      },
      async tx<T>(fn: (t: Driver) => Promise<T>): Promise<T> {
        assertOpen();
        if (depth === 0)
          return pg.transaction(async (t) => {
            await stamp(t, scope);
            return fn(wrap(t, 1, scope));
          });
        const name = `sp${depth}`;
        await q.exec(`SAVEPOINT ${name}`);
        try {
          const r = await fn(wrap(q, depth + 1, scope));
          await q.exec(`RELEASE ${name}`);
          return r;
        } catch (e) {
          await q.exec(`ROLLBACK TO ${name}`);
          await q.exec(`RELEASE ${name}`);
          throw e;
        }
      },
      onStatement(listener: (sql: string) => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      connection() {
        // Same scope: work a body defers past its commit must land in the same tenant.
        return depth === 0 ? this : connection(scope);
      },
      forTeam(team: string) {
        if (depth > 0) throw noRescope('forTeam');
        return connection({ role: 'app', team });
      },
      asOperator() {
        if (depth > 0) throw noRescope('asOperator');
        return connection({ role: 'operator', team: null });
      },
      asOwner() {
        if (depth > 0) throw noRescope('asOwner');
        return connection({ role: 'owner', team: null });
      },
      poolFactory() {
        return () => ({ connect: () => pooledClient(), end: async () => undefined });
      },
      async close() {
        if (depth > 0) return;
        closed = true;
        await pg.close();
      },
    };
  };
  // One "connection": a PGlite transaction held open until release. pgDriver sends BEGIN/COMMIT/
  // ROLLBACK itself; here PGlite's transaction is the BEGIN, a clean release is the COMMIT, and a
  // release(err) — or a ROLLBACK seen first — throws out of the callback, which rolls it back.
  const pooledClient = (): Promise<Client> =>
    new Promise<Client>((resolveClient, rejectClient) => {
      pg.transaction(async (t) => {
        let finish!: (err: unknown) => void;
        const finished = new Promise<unknown>((r) => (finish = r));
        let rolledBack = false;
        resolveClient({
          async query(text: string, values?: unknown[]) {
            if (text === 'BEGIN' || text === 'COMMIT') return { rows: [], rowCount: null };
            if (text === 'ROLLBACK') {
              rolledBack = true;
              return { rows: [], rowCount: null };
            }
            const r = await t.query(text, values);
            return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
          },
          release(err?: unknown) {
            finish(err ?? (rolledBack ? new Error('rolled back') : undefined));
          },
        });
        const err = await finished;
        if (err) throw err;
      }).catch((e: unknown) => {
        // A rollback we asked for is not an error; a failure to open the transaction is.
        if (!(e instanceof Error) || e.message !== 'rolled back') rejectClient(e);
      });
    });
  return connection({ role: 'app', team: null });
}
