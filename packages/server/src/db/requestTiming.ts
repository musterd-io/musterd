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
 * - `tx`      — transactions opened (a bare statement is one).
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
}

const store = new AsyncLocalStorage<RequestTiming>();

/** Run `fn` with a fresh timing record; returns the record alongside `fn`'s result. */
export function withRequestTiming<T>(fn: () => T): { timing: RequestTiming; result: T } {
  const timing: RequestTiming = { waitMs: 0, holdMs: 0, queryMs: 0, tx: 0 };
  return { timing, result: store.run(timing, fn) };
}

/** The current request's record, or undefined outside a request (loops, sweeps, tests). */
export const requestTiming = (): RequestTiming | undefined => store.getStore();
