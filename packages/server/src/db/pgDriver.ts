import pg from 'pg';
import { log } from '../log.js';
import { toPostgres } from './dialect.js';
import { DATABASE_UNREACHABLE_SENTENCE, DriverError, type Driver, type Params } from './driver.js';
import { ROLE, TENANT_SETTING } from './pg/tenancy.js';

/**
 * node-postgres behind the async Driver (ADR 486; cloud design §12.1/§12.4). One pool per database
 * role. Every statement — a bare `get` as much as a `tx` body — runs inside a transaction on one
 * pooled client, opened — in one round trip — with `SET LOCAL ROLE <role>` and, on a team handle,
 * `set_config(app.team_id)`,
 * so the row-level policies see exactly one tenant and a pooled connection carries nothing into
 * the next checkout (SET LOCAL dies with the transaction; ROLLBACK + release(err) on any failure).
 * The root handle is the app role with no tenant: fail-closed. `asOperator()` is the cross-tenant
 * handle (BYPASSRLS); `asOwner()` (needs `ownerUrl`) is for `migratePostgres`, never a request.
 */
export interface PgDriver extends Driver {
  /** The owner-scoped handle — migrations only. Throws unless `ownerUrl` was given. */
  asOwner(): Driver;
  /**
   * Observe every statement this driver sends, as written by the store (`?` placeholders) — the
   * SqliteDriver / PgliteDriver seam, so a query-shape count runs on real Postgres too (the Neon
   * pass). The stamping statements (BEGIN, SET LOCAL ROLE, set_config, COMMIT) are not reported.
   */
  onStatement(listener: (sql: string) => void): () => void;
}

type Scope = { role: 'owner' | 'app' | 'operator'; team: string | null };
type Result = { rows: unknown[]; rowCount: number | null };
export type Client = {
  query(text: string, values?: unknown[]): Promise<Result>;
  release(err?: unknown): void;
};
type PoolLike = { connect(): Promise<Client>; end(): Promise<void> };
/** Tests inject a fake; production builds a `pg.Pool` per URL. */
export type PoolFactory = (url: string) => PoolLike;

export interface PgDriverOptions {
  appUrl: string;
  operatorUrl: string;
  ownerUrl?: string;
  poolSize?: number;
  acquireTimeoutMs?: number;
  pools?: PoolFactory;
}

/** Socket-level failures and the server-side "not serving" states: the database is unreachable. */
const UNREACHABLE = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'ETIMEDOUT',
  'ECONNRESET',
  'EPIPE',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
  '53300', // too_many_connections
]);
const unavailable = (e: unknown) =>
  new DriverError(
    `${DATABASE_UNREACHABLE_SENTENCE}: ${e instanceof Error ? e.message : String(e)}`,
    'unavailable',
  );
const isUnreachable = (e: unknown) => {
  const code = (e as { code?: string } | null)?.code;
  return typeof code === 'string' && UNREACHABLE.has(code);
};

/**
 * The production pool: a `pg.Pool` per URL. Exported so its event handling is testable.
 *
 * node-postgres reports a dropped connection as an EVENT — on the pool when an idle client's
 * backend dies (pg-pool's idle listener), on the client itself while it is checked out — and an
 * `'error'` event with no listener is an uncaught exception: Neon suspending, failing over or
 * recycling connections would take the whole server down (review C1). Both are handled: the dead
 * client is discarded by the pool, the statement it was running already failed with the driver's
 * `unavailable` error, and the next checkout connects afresh — the 503-then-recover of spec §7.
 * Only the code is logged: a message can carry a host (hard rule 5).
 */
export function pgPoolFactory(
  opts: Pick<PgDriverOptions, 'poolSize' | 'acquireTimeoutMs'> = {},
): PoolFactory {
  const dropped = (e: unknown) =>
    log.warn({ msg: 'pg_connection_error', code: (e as { code?: unknown })?.code ?? null });
  return (connectionString) => {
    const pool = new pg.Pool({
      connectionString,
      // BIGINT (oid 20) and COUNT(*) come back as strings from `pg`; every epoch-millis column
      // and count is compared as a number by the store (none is near 2^53). Parsed per pool,
      // never via the global pg.types (the PGlite double does the same; the Neon pass found it).
      types: {
        getTypeParser: (oid: number, format?: unknown) =>
          oid === 20
            ? (v: string) => Number(v)
            : (pg.types.getTypeParser as (o: number, f?: unknown) => unknown)(oid, format),
      } as never,
      max: opts.poolSize ?? 10,
      connectionTimeoutMillis: opts.acquireTimeoutMs ?? 5_000,
    });
    pool.on('error', dropped);
    pool.on('connect', (client: { on(event: 'error', fn: (e: unknown) => void): unknown }) =>
      client.on('error', dropped),
    );
    return pool;
  };
}

export function pgDriver(opts: PgDriverOptions): PgDriver {
  const make: PoolFactory = opts.pools ?? pgPoolFactory(opts);
  const pools: Partial<Record<Scope['role'], PoolLike>> = {};
  const pool = (role: Scope['role']): PoolLike => {
    const have = pools[role];
    if (have) return have;
    const url =
      role === 'app' ? opts.appUrl : role === 'operator' ? opts.operatorUrl : opts.ownerUrl;
    return (pools[role] = make(url!));
  };
  let closed = false;
  const listeners = new Set<(sql: string) => void>();

  // BEGIN and the stamp go down as ONE simple-protocol query — one round trip, not three (lane
  // 01M3Z455NE: a bare statement was five round trips holding a pooled client). A multi-statement
  // query cannot take bind parameters, so the tenant is a literal quoted by `pg.escapeLiteral`.
  // Postgres runs a multi-statement simple query as one implicit unit: if any part fails, none of
  // it holds, and the catch below rolls back and discards the client exactly as before.
  const opening = (s: Scope): string => {
    if (s.role === 'owner') return 'BEGIN';
    const role = `SET LOCAL ROLE ${s.role === 'app' ? ROLE.app : ROLE.operator}`;
    if (s.team === null) return `BEGIN; ${role}`;
    return `BEGIN; ${role}; SELECT set_config('${TENANT_SETTING}', ${pg.escapeLiteral(s.team)}, true)`;
  };
  const acquire = async (s: Scope): Promise<Client> => {
    if (closed) throw new DriverError('driver is closed', 'closed');
    const p = pool(s.role);
    try {
      return await p.connect();
    } catch (e) {
      throw unavailable(e);
    }
  };
  // Postgres names the column, never the statement: the SQL rides on the error (as in the double).
  const query = async (c: Client, sql: string, params: Params): Promise<Result> => {
    for (const l of listeners) l(sql);
    const text = toPostgres(sql);
    try {
      return await c.query(text, params as unknown[]);
    } catch (e) {
      if (isUnreachable(e)) throw unavailable(e);
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n  in: ${text.replace(/\s+/g, ' ').trim()}`,
        { cause: e },
      );
    }
  };

  /** One transaction: BEGIN+stamp (one trip), body, COMMIT — ROLLBACK and release(err) on any failure. */
  const inTransaction = async <T>(s: Scope, body: (c: Client) => Promise<T>): Promise<T> => {
    const c = await acquire(s);
    try {
      await c.query(opening(s));
      const r = await body(c);
      await c.query('COMMIT');
      c.release();
      return r;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        // the connection is gone; release(err) discards it from the pool
      }
      c.release(e);
      throw isUnreachable(e) ? unavailable(e) : e;
    }
  };

  const noRescope = (what: string) =>
    new DriverError(
      `scope is fixed for the transaction; call ${what} on the connection handle`,
      'no_tenant_scope',
    );

  // One handle per scope, memoised: a `WeakMap<Driver, …>` cache above the store (reportCache.ts,
  // sync/pull.ts) must see the same object for the same team on every request, and a scoped handle
  // is pure configuration — nothing on it is per request.
  const scoped = new Map<string, PgDriver>();
  const connectionHandle = (s: Scope): PgDriver => {
    const key = `${s.role}:${s.team ?? ''}`;
    const have = scoped.get(key);
    if (have) return have;
    const h: PgDriver = {
      dialect: 'postgres',
      get: async <R>(sql: string, params: Params = []) =>
        inTransaction(s, async (c) => (await query(c, sql, params)).rows[0] as R | undefined),
      all: async <R>(sql: string, params: Params = []) =>
        inTransaction(s, async (c) => (await query(c, sql, params)).rows as R[]),
      run: async (sql, params = []) =>
        inTransaction(s, async (c) => ({ changes: (await query(c, sql, params)).rowCount ?? 0 })),
      exec: async (sql) => {
        await inTransaction(s, async (c) => {
          await query(c, sql, []);
        });
      },
      tx: async (fn) =>
        inTransaction(s, async (c) => {
          const { handle, settle } = txHandle(s, c, 0);
          try {
            return await fn(handle);
          } finally {
            settle();
          }
        }),
      connection: () => h,
      forTeam: (team) => connectionHandle({ role: 'app', team }),
      asOperator: () => connectionHandle({ role: 'operator', team: null }),
      asOwner: () => {
        if (!opts.ownerUrl)
          throw new DriverError('no owner URL: asOwner() is for migrations only', 'closed');
        return connectionHandle({ role: 'owner', team: null });
      },
      onStatement: (listener) => {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      close: async () => {
        closed = true;
        await Promise.all(Object.values(pools).map((p) => p.end()));
      },
    };
    scoped.set(key, h);
    return h;
  };

  // A tx handle belongs to ONE transaction: once it settles the handle refuses, loudly, so a handle
  // that leaked out through a closure cannot write into whatever transaction the client runs next
  // (same `tx_closed` contract as the SQLite driver).
  const txHandle = (s: Scope, c: Client, depth: number): { handle: Driver; settle: () => void } => {
    const life = { dead: false };
    const guard = () => {
      if (life.dead)
        throw new DriverError('tx handle used after its transaction settled', 'tx_closed');
    };
    const handle: Driver = {
      dialect: 'postgres',
      get: async <R>(sql: string, params: Params = []) => {
        guard();
        return (await query(c, sql, params)).rows[0] as R | undefined;
      },
      all: async <R>(sql: string, params: Params = []) => {
        guard();
        return (await query(c, sql, params)).rows as R[];
      },
      run: async (sql, params = []) => {
        guard();
        return { changes: (await query(c, sql, params)).rowCount ?? 0 };
      },
      exec: async (sql) => {
        guard();
        await query(c, sql, []);
      },
      tx: async (fn) => {
        guard();
        const name = `sp${depth + 1}`;
        await c.query(`SAVEPOINT ${name}`);
        const inner = txHandle(s, c, depth + 1);
        try {
          const r = await fn(inner.handle);
          await c.query(`RELEASE ${name}`);
          return r;
        } catch (e) {
          await c.query(`ROLLBACK TO ${name}`);
          await c.query(`RELEASE ${name}`);
          throw e;
        } finally {
          inner.settle();
        }
      },
      // Same scope: work a body defers past its own commit lands in the same tenant.
      connection: () => connectionHandle(s),
      forTeam: () => {
        throw noRescope('forTeam');
      },
      asOperator: () => {
        throw noRescope('asOperator');
      },
      close: async () => undefined,
    };
    return { handle, settle: () => (life.dead = true) };
  };

  return connectionHandle({ role: 'app', team: null });
}
