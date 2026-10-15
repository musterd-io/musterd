import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { log } from '../log.js';
import { toPostgres } from './dialect.js';
import {
  bodyThenCommitQueue,
  type CommitQueue,
  DATABASE_UNREACHABLE_SENTENCE,
  DriverError,
  noTransaction,
  POOL_EXHAUSTED_SENTENCE,
  type Driver,
  type Params,
} from './driver.js';
import { ROLE, TENANT_SETTING } from './pg/tenancy.js';
import { requestEnders, requestTiming, type Lease, type RequestTiming } from './requestTiming.js';

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

/**
 * pg-pool's refusal when every client is checked out and none came back within
 * `connectionTimeoutMillis` (its queued-waiter timer, pg-pool 3.x). Not a network failure: the
 * database is reachable; THIS server holds every connection. A NEW connection that times out
 * connecting is a different message ("Connection terminated due to connection timeout") and stays
 * unreachable. Pinned against the real pool in pgDriver.test.ts, so a pg upgrade that rewords it
 * fails there, not in production.
 */
export const PG_POOL_ACQUIRE_TIMEOUT = 'timeout exceeded when trying to connect';
const isPoolExhausted = (e: unknown) => e instanceof Error && e.message === PG_POOL_ACQUIRE_TIMEOUT;
/** Lane 01M3ZC3G35: the pool, not the database — its own code and stable sentence. */
const saturated = (e: unknown) =>
  new DriverError(
    `${POOL_EXHAUSTED_SENTENCE}: ${e instanceof Error ? e.message : String(e)}`,
    'saturated',
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

let driverSeq = 0;
/** ADR 507: a request's lease is returned after the transaction that outlives this. */
const LEASE_MAX_MS = 1_000;
/** ADR 507: a lease idle this long returns its client, so a stalled request cannot pin one. */
const LEASE_IDLE_MS = 250;

/** Leading whitespace and SQL comments, skipped before a statement's first keyword. */
const LEADING = /^(?:\s+|--[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)*/;
/** A row-locking clause: a SELECT that takes one is not a read for ADR 589. */
const LOCKING = /\bFOR\s+(?:NO\s+KEY\s+UPDATE|UPDATE|KEY\s+SHARE|SHARE)\b/i;

/**
 * ADR 589 decision 1: a read is a plain `SELECT` — decided by its text, not its method, because the
 * store sends `UPDATE … RETURNING` through `get` too. A row lock disqualifies it; so, conservatively,
 * does the phrase appearing anywhere in the text.
 */
export function isPlainRead(sql: string): boolean {
  const text = sql.replace(LEADING, '');
  return /^SELECT\b/i.test(text) && !LOCKING.test(text);
}

const scopeKey = (s: Scope): string => `${s.role}:${s.team ?? ''}`;

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
  const driverId = `pg${++driverSeq}`;
  // The pools whose leased transaction this async context is inside (ADR 507): a statement issued
  // from inside it on the same pool — through the connection handle, say — must not queue on the
  // lease it is already holding, so it checks a client out for itself, as before the lease.
  const holding = new AsyncLocalStorage<Set<string>>();
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
      const t = requestTiming();
      if (!t) return await p.connect();
      const t0 = performance.now();
      try {
        return await p.connect();
      } finally {
        t.waitMs += performance.now() - t0;
      }
    } catch (e) {
      throw isPoolExhausted(e) ? saturated(e) : unavailable(e);
    }
  };
  // Postgres names the column, never the statement: the SQL rides on the error (as in the double).
  const query = async (c: Client, sql: string, params: Params): Promise<Result> => {
    for (const l of listeners) l(sql);
    const text = toPostgres(sql);
    try {
      const t = requestTiming();
      if (!t) return await c.query(text, params as unknown[]);
      t.stmt++;
      const t0 = performance.now();
      try {
        return await c.query(text, params as unknown[]);
      } finally {
        t.queryMs += performance.now() - t0;
      }
    } catch (e) {
      if (isUnreachable(e)) throw unavailable(e);
      throw new Error(
        `${e instanceof Error ? e.message : String(e)}\n  in: ${text.replace(/\s+/g, ' ').trim()}`,
        { cause: e },
      );
    }
  };

  /**
   * One transaction on client `c`: BEGIN+stamp (one trip), body, COMMIT. On any failure, ROLLBACK
   * and hand back `release(err)` — the caller discards the client — so a pooled connection never
   * carries a half-open transaction into its next use.
   */
  const onClient = async <T>(
    c: Client,
    s: Scope,
    body: (c: Client) => Promise<T>,
    commitFirst = false,
  ): Promise<{ ok: true; r: T } | { ok: false; e: unknown }> => {
    // Request timing (requestTiming.ts): how long this client is held, BEGIN to COMMIT/ROLLBACK.
    const timing = requestTiming();
    const held = performance.now();
    if (timing) timing.tx++;
    try {
      // ADR 589 decision 3: a read run left open on a lease commits in this same round trip.
      await c.query(commitFirst ? `COMMIT; ${opening(s)}` : opening(s));
      const r = await body(c);
      await c.query('COMMIT');
      return { ok: true, r };
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {
        // the connection is gone; release(err) discards it from the pool
      }
      return { ok: false, e };
    } finally {
      if (timing) timing.holdMs += performance.now() - held;
    }
  };

  /**
   * ADR 589 decision 2: a read on a lease. It joins the read transaction the lease left open when the
   * scope matches (one round trip: the statement); otherwise it commits that one and opens its own in
   * one trip, and leaves it open for the next read. On failure the run rolls back — it held only
   * reads — and the caller discards the client, as for any failed transaction (ADR 507 §6).
   */
  const onLeasedRead = async <T>(
    c: Client,
    s: Scope,
    lease: Lease,
    body: (c: Client) => Promise<T>,
  ): Promise<{ ok: true; r: T } | { ok: false; e: unknown }> => {
    const timing = requestTiming();
    const held = performance.now();
    const key = scopeKey(s);
    try {
      if (lease.open !== key) {
        if (timing) timing.tx++;
        await c.query(lease.open ? `COMMIT; ${opening(s)}` : opening(s));
        lease.open = key;
      }
      return { ok: true, r: await body(c) };
    } catch (e) {
      lease.open = null;
      try {
        await c.query('ROLLBACK');
      } catch {
        // the connection is gone; release(err) discards it from the pool
      }
      return { ok: false, e };
    } finally {
      if (timing) timing.holdMs += performance.now() - held;
    }
  };

  /**
   * Give a lease's client back (ADR 507 §4–5), committing the read run it left open first (ADR 589
   * decision 4). The lease lets go of the client before the commit is awaited, so work arriving
   * meanwhile leases afresh rather than racing the commit.
   */
  const closeLease = async (lease: Lease): Promise<void> => {
    const c = lease.client as Client | null;
    const open = lease.open;
    lease.client = null;
    lease.open = null;
    if (!c) return;
    if (!open) return c.release();
    try {
      await c.query('COMMIT');
      c.release();
    } catch (e) {
      c.release(e);
    }
  };

  /**
   * One transaction. Inside an HTTP request scope (ADR 507) it runs on the request's leased client
   * for this pool — one checkout per request, not per statement — one transaction at a time;
   * anywhere else, and re-entrantly inside a leased transaction, it checks a client out for itself.
   */
  const inTransaction = async <T>(
    s: Scope,
    body: (c: Client) => Promise<T>,
    /** ADR 589: a bare plain-`SELECT` statement, which may join the lease's open read run. */
    read = false,
  ): Promise<T> => {
    const scope = requestTiming();
    // Keyed by this driver AND pool: the coordination and trace stores are two drivers on two
    // databases sharing one request, and neither may run on the other's client.
    const key = `${driverId}:${s.role}`;
    if (scope && !scope.ended && !holding.getStore()?.has(key)) {
      const lease = (scope.leases[key] ??= {
        client: null,
        since: 0,
        idle: null,
        tail: Promise.resolve(),
        open: null,
      });
      if (lease.idle) clearTimeout(lease.idle);
      lease.idle = null;
      const prev = lease.tail;
      let free!: () => void;
      lease.tail = new Promise<void>((r) => (free = r));
      await prev;
      try {
        if (!scope.ended) {
          if (!lease.client) {
            lease.client = await acquire(s);
            lease.since = performance.now();
          }
          const c = lease.client as Client;
          const held = new Set(holding.getStore() ?? []).add(key);
          let out: { ok: true; r: T } | { ok: false; e: unknown };
          if (read) {
            out = await holding.run(held, () => onLeasedRead(c, s, lease, body));
          } else {
            const commitFirst = lease.open !== null;
            lease.open = null;
            out = await holding.run(held, () => onClient(c, s, body, commitFirst));
          }
          if (!out.ok) {
            lease.client = null;
            lease.open = null;
            c.release(out.e);
            throw isUnreachable(out.e) ? unavailable(out.e) : out.e;
          }
          // A long-lived response (an MCP stream) must not pin a client: past LEASE_MAX_MS the
          // client goes back after this transaction and the next statement leases afresh.
          if (performance.now() - lease.since > LEASE_MAX_MS) await closeLease(lease);
          return out.r;
        }
      } finally {
        free();
        armIdle(lease);
      }
    }
    const c = await acquire(s);
    const out = await onClient(c, s, body);
    if (out.ok) {
      c.release();
      return out.r;
    }
    c.release(out.e);
    throw isUnreachable(out.e) ? unavailable(out.e) : out.e;
  };

  /**
   * A lease that runs nothing for LEASE_IDLE_MS gives its client back (ADR 507 §5): a request that
   * leased and then stalls — a slow client, a stream waiting on nothing — holds a client for at
   * most that long, so open-but-idle requests cannot drain the pool. The next statement leases
   * afresh. The release queues behind any work already on the lease.
   */
  const armIdle = (lease: Lease): void => {
    if (!lease.client || lease.idle) return;
    lease.idle = setTimeout(() => {
      lease.idle = null;
      void lease.tail.then(() => {
        if (lease.idle) return; // new work arrived and re-armed it
        return closeLease(lease);
      });
    }, LEASE_IDLE_MS);
    lease.idle.unref?.();
  };

  /**
   * End a request scope (ADR 507): no statement may take its leases from now on, and each leased
   * client goes back to its pool once the work already queued on it settles.
   */
  const endRequest = async (scope: RequestTiming): Promise<void> => {
    scope.ended = true;
    await Promise.all(
      Object.entries(scope.leases)
        .filter(([k]) => k.startsWith(`${driverId}:`))
        .map(async ([, lease]) => {
          if (lease!.idle) clearTimeout(lease!.idle);
          lease!.idle = null;
          await lease!.tail;
          await closeLease(lease!);
        }),
    );
  };
  requestEnders.add(endRequest);

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
        inTransaction(
          s,
          async (c) => (await query(c, sql, params)).rows[0] as R | undefined,
          isPlainRead(sql),
        ),
      all: async <R>(sql: string, params: Params = []) =>
        inTransaction(s, async (c) => (await query(c, sql, params)).rows as R[], isPlainRead(sql)),
      run: async (sql, params = []) =>
        inTransaction(s, async (c) => ({ changes: (await query(c, sql, params)).rowCount ?? 0 })),
      exec: async (sql) => {
        await inTransaction(s, async (c) => {
          await query(c, sql, []);
        });
      },
      tx: async (fn) =>
        inTransaction(s, async (c) => {
          const queue: CommitQueue = [];
          const { handle, settle } = txHandle(s, c, 0, queue);
          try {
            return await bodyThenCommitQueue(handle, queue, fn);
          } finally {
            settle();
          }
        }),
      beforeCommit: noTransaction,
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
        requestEnders.delete(endRequest);
        await Promise.all(Object.values(pools).map((p) => p.end()));
      },
    };
    scoped.set(key, h);
    return h;
  };

  // A tx handle belongs to ONE transaction: once it settles the handle refuses, loudly, so a handle
  // that leaked out through a closure cannot write into whatever transaction the client runs next
  // (same `tx_closed` contract as the SQLite driver).
  const txHandle = (
    s: Scope,
    c: Client,
    depth: number,
    queue: CommitQueue,
  ): { handle: Driver; settle: () => void } => {
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
        // The savepoint's own queue: it joins the parent's only if the savepoint survives.
        const mine: CommitQueue = [];
        const inner = txHandle(s, c, depth + 1, mine);
        try {
          const r = await fn(inner.handle);
          await c.query(`RELEASE ${name}`);
          queue.push(...mine);
          return r;
        } catch (e) {
          await c.query(`ROLLBACK TO ${name}`);
          await c.query(`RELEASE ${name}`);
          throw e;
        } finally {
          inner.settle();
        }
      },
      beforeCommit: (fn) => {
        guard();
        queue.push(fn);
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
