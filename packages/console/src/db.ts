/**
 * The console's database seam (ADR 615). Anything with `query(sql, params) → { rows }` — a `pg`
 * Pool in production, PGlite in tests — so no store layer is imported from `@musterd/server`
 * (only `@musterd/protocol` crosses package boundaries).
 */
export interface Queryable {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

/** The stable sentences a boot refusal prints — the same words the team server uses (spec §6). */
export const SCHEMA_NEWER_SENTENCE = 'schema newer than this build';
export const SCHEMA_OLDER_SENTENCE = 'schema older than this build';
/** The one sentence `/health` answers with when the database cannot be reached (spec §5.5). */
export const DATABASE_UNREACHABLE_SENTENCE = 'database unreachable';

/** The schema version recorded in `console_meta`, or 0 when the table does not exist yet. */
export async function schemaVersion(db: Queryable): Promise<number> {
  const exists = await db.query<{ t: string | null }>(
    "SELECT to_regclass('console_meta')::text AS t",
  );
  if (!exists.rows[0]?.t) return 0;
  const r = await db.query<{ value: string }>(
    "SELECT value FROM console_meta WHERE key = 'schema_version'",
  );
  return Number(r.rows[0]?.value ?? 0);
}

/** Boot refuses a schema that is not exactly this build's — never migrate on boot (spec §6). */
export async function assertSchema(db: Queryable, expected: number): Promise<void> {
  const have = await schemaVersion(db);
  if (have > expected)
    throw new Error(
      `${SCHEMA_NEWER_SENTENCE}: database is at schema ${have}, this build knows ${expected}`,
    );
  if (have < expected)
    throw new Error(
      `${SCHEMA_OLDER_SENTENCE}: database is at schema ${have}, this build needs ${expected}`,
    );
}
