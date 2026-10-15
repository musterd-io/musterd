/**
 * The one store interface (ADR 479 §2): every read and write in the server goes through it, and the
 * driver owns the dialect. `?` placeholders everywhere; a Postgres driver renumbers them. Params are
 * an array, never spread. `tx` hands the body a Driver bound to the transaction — statements inside
 * the body go through THAT handle (the SQLite driver serialises; the outer handle would wait).
 */
/** Bound parameters. Deliberately `unknown`: the store builds these arrays from row objects and
 *  JSON.stringify results as it always has, and the engine — not the type — rejects a bad value,
 *  exactly as better-sqlite3 did before the Driver. */
export type Params = ReadonlyArray<unknown>;

export interface Driver {
  readonly dialect: 'sqlite' | 'postgres';
  get<R = Record<string, unknown>>(sql: string, params?: Params): Promise<R | undefined>;
  all<R = Record<string, unknown>>(sql: string, params?: Params): Promise<R[]>;
  run(sql: string, params?: Params): Promise<{ changes: number }>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (t: Driver) => Promise<T>): Promise<T>;
  /**
   * Queue `fn` to run on the outermost open transaction after its body succeeds, just before COMMIT
   * (ADR 531). Callbacks run in registration order. One registered inside a savepoint that rolls
   * back is dropped with it. A throw rolls the whole transaction back. Only a transaction handle
   * has a commit to run before; the connection handle refuses with `no_transaction`.
   */
  beforeCommit(fn: (t: Driver) => Promise<void>): void;
  /**
   * The connection-level handle. On a tx handle this is the queue-level driver: work a body defers
   * past its own commit (a notification's `.then`) writes through it, never through the tx handle
   * that will be dead by then. On the connection handle it returns itself.
   */
  connection(): Driver;
  /**
   * A handle scoped to one team (spec §12.1). On Postgres every transaction it opens runs
   * `SET LOCAL app.team_id = <teamId>` as the app role, so row-level security admits only that
   * team's rows; the unscoped connection handle admits none. On SQLite — one team per file — it is
   * the handle itself.
   */
  forTeam(teamId: string): Driver;
  /**
   * The cross-tenant handle for work that is legitimately about every team: the presence reaper,
   * retention, the census, `/health`, team creation, the sync loops. On Postgres it runs as
   * `musterd_operator` (BYPASSRLS). `asOperator(` is the audit list of every cross-tenant read.
   */
  asOperator(): Driver;
  close(): Promise<void>;
}

export type DriverErrorCode =
  | 'outer_handle_in_tx'
  | 'tx_closed'
  | 'no_transaction'
  | 'not_sqlite'
  | 'closed'
  | 'unavailable'
  | 'saturated'
  | 'no_tenant_scope';

/**
 * The stable sentence (cloud spec §5.5 / §7) for a store that cannot be reached: what a
 * `DriverError('unavailable')` carries, what `/health` reports, what a 503 says. Matched by probes
 * and banners — never reworded.
 */
export const DATABASE_UNREACHABLE_SENTENCE = 'database unreachable';

/**
 * The stable sentence for a store that IS reachable but whose connection pool had no client free
 * within the acquire timeout: what a `DriverError('saturated')` carries. The 2026-10-02 load test
 * (lane 01M3ZC3G35) answered 3,565 of these "database unreachable" while Neon served throughout —
 * the app was starved, not the database out — so the two causes carry two sentences. Never reworded.
 */
export const POOL_EXHAUSTED_SENTENCE = 'database pool exhausted';

/**
 * The stable 503 sentence a store failure carries, or null when it is not an availability failure:
 * `unavailable` (cannot reach it) and `saturated` (reached, but no pooled client free in time).
 */
export function unavailableSentence(err: unknown): string | null {
  if (!(err instanceof DriverError)) return null;
  if (err.code === 'unavailable') return DATABASE_UNREACHABLE_SENTENCE;
  if (err.code === 'saturated') return POOL_EXHAUSTED_SENTENCE;
  return null;
}

export class DriverError extends Error {
  constructor(
    message: string,
    readonly code: DriverErrorCode,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}

/** One transaction's — or one savepoint's — queued `beforeCommit` callbacks (ADR 531). */
export type CommitQueue = Array<(t: Driver) => Promise<void>>;

/** The connection handle's `beforeCommit`: there is no transaction to run before. */
export function noTransaction(): never {
  throw new DriverError(
    'beforeCommit needs a transaction handle; call it inside tx()',
    'no_transaction',
  );
}

/**
 * The outermost transaction's body, then its queue, both on `t`, before the caller COMMITs. A
 * callback may queue another (the loop drains it). A throw anywhere leaves the caller to roll back.
 */
export async function bodyThenCommitQueue<T>(
  t: Driver,
  queue: CommitQueue,
  fn: (t: Driver) => Promise<T>,
): Promise<T> {
  const r = await fn(t);
  for (let next = queue.shift(); next; next = queue.shift()) await next(t);
  return r;
}
