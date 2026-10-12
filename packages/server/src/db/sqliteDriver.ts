import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';
import { log } from '../log.js';
import {
  bodyThenCommitQueue,
  type CommitQueue,
  DriverError,
  noTransaction,
  type Driver,
  type Params,
} from './driver.js';
import { requestTiming } from './requestTiming.js';

/**
 * A transaction holding the queue this long is logged with where it was opened (lane 01M4S0ZAG8):
 * every other statement waits behind it, so a body that awaits something slow stalls the daemon's
 * whole store, and nothing else names the holder.
 */
const SLOW_TX_MS = 1_000;

/** The first few frames outside this file, paths cut to the package — enough to name the caller. */
function callSite(site: Error): string {
  return (site.stack ?? '')
    .split('\n')
    .slice(1)
    .filter((l) => !/sqliteDriver\.(ts|js):/.test(l) && !l.includes('node:internal'))
    .slice(0, 4)
    .map((l) =>
      l
        .trim()
        .replace(/^at /, '')
        .replace(/\(?(?:file:\/\/)?\/.*?\/(src|dist)\//, '$1/'),
    )
    .join(' < ');
}

/**
 * better-sqlite3 behind the async Driver. Every statement is synchronous underneath; the Promise is
 * the interface, not concurrency. Transactions are a QUEUE (ADR 479 §2 / spike Q3): one `tx` runs
 * at a time, statements from outside an open tx wait for its commit, and the body's statements go
 * through the tx handle — so today's "nothing interleaves inside db.transaction(fn)" holds exactly.
 * Nested tx = SAVEPOINT.
 */
export interface SqliteDriver extends Driver {
  readonly dialect: 'sqlite';
  /** Transition-only (plan 1A Task 24 removes it): the raw handle for not-yet-converted callees. */
  readonly raw: Database.Database;
  /**
   * Observe every statement this connection executes (outer handle and tx handles alike). A test
   * seam: the statement cache means "how many times was this prepared" no longer says how many
   * times it ran, so a cost test counts executions here. Returns the detach function.
   */
  onStatement(listener: (sql: string) => void): () => void;
}

/** One driver per connection: two queues on one better-sqlite3 handle would race BEGIN. */
const drivers = new WeakMap<Database.Database, SqliteDriver>();

export function sqliteDriver(input: Database.Database | SqliteDriver): SqliteDriver {
  // Idempotent: a handle that is already a Driver (any dialect, or the test hybrid) is returned as
  // is — a test that wraps whatever `withDrivers` handed it must not re-wrap a PGlite driver.
  if (typeof (input as Partial<SqliteDriver>).dialect === 'string') return input as SqliteDriver;
  const raw = input as Database.Database;
  const cached = drivers.get(raw);
  if (cached) return cached;
  const driver = buildSqliteDriver(raw);
  drivers.set(raw, driver);
  return driver;
}

function buildSqliteDriver(raw: Database.Database): SqliteDriver {
  const stmts = new Map<string, Database.Statement>();
  const listeners = new Set<(sql: string) => void>();
  const notify = (sql: string) => {
    for (const l of listeners) l(sql);
  };
  const prep = (sql: string) => {
    let s = stmts.get(sql);
    if (!s) {
      s = raw.prepare(sql);
      stmts.set(sql, s);
    }
    return s;
  };
  let closed = false;
  // The queue: `tail` settles when the last queued transaction has finished. A tx claims its slot
  // SYNCHRONOUSLY (before its first await), so two tx() calls issued in the same tick cannot both
  // see an empty queue — that race is exactly what "cannot start a transaction within a
  // transaction" looks like.
  let tail: Promise<void> = Promise.resolve();
  let depth = 0;
  // Whether the caller's async context is inside a running tx body. An outer-handle statement from
  // INSIDE a body would wait on its own transaction forever, so it throws; the same statement from
  // another request (outside any body) simply waits for the commit — the flag alone cannot tell
  // those apart, the async context can.
  // The store carries the tx's liveness: a continuation registered inside the body (a webhook's
  // `.then`) still sees the store after COMMIT, and by then an outer statement is fine.
  const inBody = new AsyncLocalStorage<{ open: boolean }>();

  const assertOpen = () => {
    if (closed) throw new DriverError('driver is closed', 'closed');
  };
  const outerInsideBody = () =>
    new DriverError('outer handle used inside tx — use the tx handle', 'outer_handle_in_tx');

  const txClosed = () =>
    new DriverError('tx handle used after its transaction settled', 'tx_closed');

  // Every outer-handle statement executes IN THE REACTION that observes `tail` settle — not one
  // microtask later. Two hops would let the next queued tx's BEGIN (one hop) slip in between, and
  // the statement would land inside a foreign transaction (review C1, 2026-09-30). Registration
  // order on `tail` is then exactly the order the calls were issued in.
  const onQueue = <R>(sql: string, run: () => R): Promise<R> => {
    assertOpen();
    if (inBody.getStore()?.open) return Promise.reject(outerInsideBody());
    const timing = requestTiming();
    const asked = timing ? performance.now() : 0;
    return tail.then(() => {
      if (timing) timing.waitMs += performance.now() - asked;
      assertOpen();
      notify(sql);
      return run();
    });
  };
  // A tx handle belongs to ONE transaction: it never waits on the queue, and once its transaction
  // has committed or rolled back it refuses, loudly, so a handle that leaked out through a closure
  // (a notification's `.then`, a cached ctx) cannot write into whatever transaction runs next.
  const inTx = <R>(life: { dead: boolean }, sql: string, run: () => R): Promise<R> => {
    if (life.dead) return Promise.reject(txClosed());
    assertOpen();
    notify(sql);
    try {
      return Promise.resolve(run());
    } catch (e) {
      return Promise.reject(e);
    }
  };

  // `queue` is the open transaction's (or savepoint's) beforeCommit queue; null on the outer handle.
  const make = (life: { dead: boolean } | null, queue: CommitQueue | null): SqliteDriver => {
    const stmt = <R>(sql: string, run: () => R): Promise<R> =>
      life ? inTx(life, sql, run) : onQueue(sql, run);
    const handle: SqliteDriver = {
      dialect: 'sqlite',
      raw,
      onStatement(listener: (sql: string) => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      beforeCommit(fn) {
        if (!life || !queue) noTransaction();
        if (life.dead) throw txClosed();
        queue.push(fn);
      },
      connection() {
        return outer;
      },
      // One team per file: the tenant seam is the handle itself (spec §12.1).
      forTeam() {
        return handle;
      },
      asOperator() {
        return handle;
      },
      async get<R>(sql: string, params: Params = []) {
        return stmt(sql, () => prep(sql).get(...(params as unknown[])) as R | undefined);
      },
      async all<R>(sql: string, params: Params = []) {
        return stmt(sql, () => prep(sql).all(...(params as unknown[])) as R[]);
      },
      async run(sql: string, params: Params = []) {
        return stmt(sql, () => ({
          changes: Number(prep(sql).run(...(params as unknown[])).changes),
        }));
      },
      async exec(sql: string) {
        return stmt(sql, () => {
          raw.exec(sql);
        });
      },
      async tx<T>(fn: (t: Driver) => Promise<T>): Promise<T> {
        assertOpen();
        if (life) {
          if (life.dead) throw txClosed();
          // Nested: a savepoint on the same connection, same queue slot, same handle lifetime.
          const name = `sp${++depth}`;
          raw.exec(`SAVEPOINT ${name}`);
          const mine: CommitQueue = [];
          try {
            const r = await fn(make(life, mine));
            raw.exec(`RELEASE ${name}`);
            queue!.push(...mine);
            return r;
          } catch (e) {
            raw.exec(`ROLLBACK TO ${name}`);
            raw.exec(`RELEASE ${name}`);
            throw e;
          } finally {
            depth--;
          }
        }
        if (inBody.getStore()?.open) throw outerInsideBody();
        const prev = tail;
        let release!: () => void;
        tail = new Promise<void>((r) => (release = r));
        // Where this transaction was opened; the stack is only formatted if it turns out slow.
        const site = new Error();
        const timing = requestTiming();
        const asked = performance.now();
        let began: number | null = null;
        try {
          await prev;
          assertOpen();
          depth = 1;
          const mine = { dead: false, open: true };
          began = performance.now();
          if (timing) {
            timing.tx++;
            timing.waitMs += began - asked;
          }
          raw.exec('BEGIN');
          try {
            const root: CommitQueue = [];
            const r = await inBody.run(mine, () => bodyThenCommitQueue(make(mine, root), root, fn));
            raw.exec('COMMIT');
            return r;
          } catch (e) {
            // SQLite may already have rolled back on its own (SQLITE_FULL/IOERR on COMMIT); a
            // second ROLLBACK would throw and mask the real error.
            if (raw.inTransaction) raw.exec('ROLLBACK');
            throw e;
          } finally {
            mine.dead = true;
            mine.open = false;
            depth = 0;
          }
        } finally {
          release();
          if (began !== null) {
            const held = performance.now() - began;
            if (timing) timing.holdMs += held;
            if (held >= SLOW_TX_MS)
              log.warn({
                msg: 'sqlite_tx_slow',
                hold_ms: Math.round(held),
                wait_ms: Math.round(began - asked),
                at: callSite(site),
              });
          }
        }
      },
      async close() {
        if (life) return;
        await tail;
        closed = true;
        stmts.clear();
        raw.close();
      },
    };
    return handle;
  };
  const outer = make(null, null);
  return outer;
}
