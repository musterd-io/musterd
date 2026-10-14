import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Where one HTTP request's time went inside the store (lane 01M3Z455NE). Cloud load runs 5c–8 put
 * writes at 10–100 s while Postgres held no transaction longer than 0.18 s and the server's main
 * thread sat half idle — the wait is between the two, and these fields name it on the request's
 * own `http_request` log line:
 *
 * - `waitMs`  — summed time waiting to check a client out of the pool;
 * - `holdMs`  — summed time a checked-out client was held (BEGIN … COMMIT), awaits included;
 * - `queryMs` — summed time inside `client.query` (the database's answer plus the wire);
 * - `tx`      — transactions opened (a bare statement is one; ADR 589: a run of reads is one);
 * - `stmt`    — store statements sent, so a request's work and its transactions can be told apart.
 *
 * `holdMs - queryMs` is time a client sat idle in transaction waiting on this process. Recorded by
 * the pg driver only; SQLite and the PGlite double leave it empty, and a request that touched no
 * Postgres store logs no fields.
 */
export interface RequestTiming {
  waitMs: number;
  holdMs: number;
  queryMs: number;
  tx: number;
  stmt: number;
  /**
   * ADR 507: the client this request leased per pool, and the queue that runs its transactions
   * one at a time. Owned by the pg driver; empty on every other engine.
   */
  leases: Partial<Record<string, Lease>>;
  /** Set when the request ends: no statement may take a lease after this. */
  ended: boolean;
}

/** One request's client on one pool (ADR 507). `tail` settles when its queued work has. */
export interface Lease {
  client: { release(err?: unknown): void } | null;
  /** When `client` was checked out (performance.now()), for the lease's age cap. */
  since: number;
  /** Pending idle release (LEASE_IDLE_MS); cleared when new work arrives. */
  idle: ReturnType<typeof setTimeout> | null;
  tail: Promise<void>;
  /**
   * ADR 589: the scope (role and tenant) of a read transaction this lease left open on `client`, or
   * null. The next read of that scope runs inside it; anything else commits it first.
   */
  open: string | null;
}

/** The drivers that hold leases register how to end a request; `endRequestTiming` calls them. */
export const requestEnders = new Set<(t: RequestTiming) => Promise<void>>();

/** The request is over (response finished or closed): return every leased client (ADR 507). */
export async function endRequestTiming(t: RequestTiming): Promise<void> {
  t.ended = true;
  await Promise.all([...requestEnders].map((end) => end(t)));
}

const store = new AsyncLocalStorage<RequestTiming>();

/** Run `fn` with a fresh timing record; returns the record alongside `fn`'s result. */
export function withRequestTiming<T>(fn: () => T): { timing: RequestTiming; result: T } {
  const timing: RequestTiming = {
    waitMs: 0,
    holdMs: 0,
    queryMs: 0,
    tx: 0,
    stmt: 0,
    leases: {},
    ended: false,
  };
  return { timing, result: store.run(timing, fn) };
}

/** The current request's record, or undefined outside a request (loops, sweeps, tests). */
export const requestTiming = (): RequestTiming | undefined => store.getStore();
