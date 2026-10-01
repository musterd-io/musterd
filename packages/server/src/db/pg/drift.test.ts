import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations.js';
import { pgliteDriver } from '../pgliteDriver.js';
import { TRACE_MIGRATIONS } from '../traceDb.js';
import { migratePostgres, migrateTracePostgres } from './migrate.js';

/** FTS5 shadow tables — SQLite-only by construction (the tsvector table replaces the feature). */
const SQLITE_ONLY = /^insights_fts_(config|content|data|docsize|idx)$/;
/** Columns the Postgres side alone carries: the generated tsvector behind the GIN index. */
const PG_ONLY_COLUMNS: Record<string, string[]> = { insights_fts: ['tsv'] };

/**
 * Spec §12.2: the frozen baseline + the portable ladder must land on exactly the table/column set
 * the SQLite ladder lands on. Written against the current state and expected to PASS; it is the
 * falsifier for every future migration. If it fails, the baseline or the ladder entry is wrong —
 * fix those, never the test.
 */
describe('the two schemas agree (spec §12.2)', () => {
  it('same tables, same column names, per table', async () => {
    const s = new Database(':memory:');
    runMigrations(s);
    const sTables = (
      s
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    )
      .map((r) => r.name)
      .filter((t) => !SQLITE_ONLY.test(t))
      .sort();
    const p = await pgliteDriver();
    const owner = p.asOwner();
    await migratePostgres(owner);
    const pTables = (
      await owner.all<{ t: string }>(
        "SELECT table_name AS t FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'",
      )
    )
      .map((r) => r.t)
      .sort();
    expect(pTables).toEqual(sTables);
    for (const t of sTables) {
      // table_xinfo: table_info hides generated columns (messages.in_reply_to, v71; hidden 2/3).
      // hidden = 1 is an FTS5 virtual table's implicit `<table>` and `rank` columns — not schema.
      const sc = (
        s.prepare(`PRAGMA table_xinfo("${t}")`).all() as { name: string; hidden: number }[]
      )
        .filter((c) => c.hidden !== 1)
        .map((c) => c.name)
        .sort();
      const pc = (
        await owner.all<{ c: string }>(
          'SELECT column_name AS c FROM information_schema.columns WHERE table_name = ?',
          [t],
        )
      )
        .map((r) => r.c)
        .filter((c) => !(PG_ONLY_COLUMNS[t] ?? []).includes(c))
        .sort();
      expect(pc, t).toEqual(sc);
    }
    await p.close();
  });

  it('the trace store too: TRACE_MIGRATIONS ≙ trace-0003-baseline + TRACE_LADDER', async () => {
    const s = new Database(':memory:');
    runMigrations(s, TRACE_MIGRATIONS);
    const p = await pgliteDriver();
    const owner = p.asOwner();
    await migrateTracePostgres(owner);
    for (const t of ['schema_meta', 'trace_events']) {
      const sc = (s.prepare(`PRAGMA table_xinfo("${t}")`).all() as { name: string }[])
        .map((c) => c.name)
        .sort();
      const pc = (
        await owner.all<{ c: string }>(
          'SELECT column_name AS c FROM information_schema.columns WHERE table_name = ?',
          [t],
        )
      )
        .map((r) => r.c)
        .sort();
      expect(pc, t).toEqual(sc);
    }
    await p.close();
  });
});
