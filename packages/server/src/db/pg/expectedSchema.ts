import Database from 'better-sqlite3';
import { runMigrations } from '../migrations.js';
import { TRACE_MIGRATIONS } from '../traceDb.js';

/** FTS5 shadow tables — SQLite-only by construction (the tsvector table replaces the feature). */
const SQLITE_ONLY = /^insights_fts_(config|content|data|docsize|idx)$/;
/** Columns the Postgres side alone carries: the generated tsvector behind the GIN index. */
const PG_ONLY_COLUMNS: Record<string, string[]> = { insights_fts: ['tsv'] };

export type StoreName = 'main' | 'trace';
export type ExpectedSchema = ReadonlyMap<string, ReadonlySet<string>>;

const cache: Partial<Record<StoreName, ExpectedSchema>> = {};

/**
 * The table → column set a Postgres database must carry for `store` (ADR 496): what the SQLite
 * ladder lands on an in-memory database, under the two translation rules spec §12.2 lets the
 * engines differ by (above). Derived, never hand-kept, so a new ladder entry needs no second file
 * to stay in step with — `drift.test.ts` holds the Postgres baseline + ladder to the same set on a
 * fresh database; `verifyPostgresSchema` holds a LIVE database to it. One in-memory SQLite per
 * process, on first use.
 */
export function expectedSchema(store: StoreName): ExpectedSchema {
  const have = cache[store];
  if (have) return have;
  const s = new Database(':memory:');
  try {
    if (store === 'trace') runMigrations(s, TRACE_MIGRATIONS);
    else runMigrations(s);
    const tables = (
      s
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((t) => !SQLITE_ONLY.test(t));
    const out = new Map<string, Set<string>>();
    for (const t of tables) {
      // table_xinfo: table_info hides generated columns (messages.in_reply_to, v71; hidden 2/3).
      // hidden = 1 is an FTS5 virtual table's implicit `<table>` and `rank` columns — not schema.
      const cols = (
        s.prepare(`PRAGMA table_xinfo("${t}")`).all() as { name: string; hidden: number }[]
      )
        .filter((c) => c.hidden !== 1)
        .map((c) => c.name);
      out.set(t, new Set([...cols, ...(PG_ONLY_COLUMNS[t] ?? [])]));
    }
    return (cache[store] = out);
  } finally {
    s.close();
  }
}
