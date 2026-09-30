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
   * The connection-level handle. On a tx handle this is the queue-level driver: work a body defers
   * past its own commit (a notification's `.then`) writes through it, never through the tx handle
   * that will be dead by then. On the connection handle it returns itself.
   */
  connection(): Driver;
  close(): Promise<void>;
}

export type DriverErrorCode = 'outer_handle_in_tx' | 'tx_closed' | 'not_sqlite' | 'closed';

export class DriverError extends Error {
  constructor(
    message: string,
    readonly code: DriverErrorCode,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
