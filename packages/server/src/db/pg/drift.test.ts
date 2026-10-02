import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../migrations.js';
import { pgliteDriver } from '../pgliteDriver.js';
import { TRACE_MIGRATIONS } from '../traceDb.js';
import { expectedSchema } from './expectedSchema.js';
import { migratePostgres, migrateTracePostgres, verifyPostgresSchema } from './migrate.js';

/**
 * Spec §12.2: the frozen baseline + the portable ladder must land on exactly the table/column set
 * the SQLite ladder lands on. Written against the current state and expected to PASS; it is the
 * falsifier for every future migration. If it fails, the baseline or the ladder entry is wrong —
 * fix those, never the test. The comparison is `verifyPostgresSchema` (ADR 496) against
 * `expectedSchema` — the same check a LIVE database gets after its ladder, run here on a fresh one,
 * so the two can never disagree about what "the schema" is.
 */
describe('the two schemas agree (spec §12.2)', () => {
  it('same tables, same column names, per table', async () => {
    const p = await pgliteDriver();
    const owner = p.asOwner();
    await migratePostgres(owner);
    expect(await verifyPostgresSchema(owner, 'main')).toEqual({ missing: [], extra: [] });
    await p.close();
  });

  it('the trace store too: TRACE_MIGRATIONS ≙ trace-0003-baseline + TRACE_LADDER', async () => {
    const p = await pgliteDriver();
    const owner = p.asOwner();
    await migrateTracePostgres(owner);
    expect(await verifyPostgresSchema(owner, 'trace')).toEqual({ missing: [], extra: [] });
    await p.close();
  });

  it('expectedSchema is the SQLite ladder as landed, under the two translation rules, and nothing else', () => {
    // The derivation is what every check above stands on: hold it to the engine it reads from.
    const s = new Database(':memory:');
    runMigrations(s);
    const tables = (
      s
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    const main = expectedSchema('main');
    for (const t of tables.filter((t) => !/^insights_fts_/.test(t)))
      expect(main.has(t), t).toBe(true);
    expect(
      [...main.keys()].some((t) => /^insights_fts_(config|content|data|docsize|idx)$/.test(t)),
    ).toBe(false);
    expect(main.get('insights_fts')?.has('tsv')).toBe(true);
    expect(main.get('lanes')?.has('follows_up_json')).toBe(true);
    expect(main.get('lanes')?.has('in_reply_to')).toBe(false);
    s.close();
    const trace = expectedSchema('trace');
    expect([...trace.keys()].sort()).toEqual(['schema_meta', 'trace_events']);
    runMigrations(new Database(':memory:'), TRACE_MIGRATIONS);
  });
});
