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
  | 'not_sqlite'
  | 'closed'
  | 'unavailable'
  | 'no_tenant_scope';

export class DriverError extends Error {
  constructor(
    message: string,
    readonly code: DriverErrorCode,
  ) {
    super(message);
    this.name = 'DriverError';
  }
}
