import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import { SCHEMA_NEWER_SENTENCE } from './guard.js';
import { runMigrations } from './migrations.js';
import { openDb } from './open.js';
import { migratePostgres } from './pg/migrate.js';
import { pgliteDriver } from './pgliteDriver.js';
import { openTraceDb, TRACE_MIGRATIONS } from './traceDb.js';

const BUMP = "UPDATE schema_meta SET value = '9999' WHERE key = 'schema_version'";

describe('schema version guard (spec §6)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'musterd-guard-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('SQLite: a database at a version this build does not know refuses, with the stable sentence', () => {
    const raw = new Database(':memory:');
    runMigrations(raw);
    raw.prepare(BUMP).run();
    expect(() => runMigrations(raw)).toThrow(SCHEMA_NEWER_SENTENCE);
    // The trace ladder shares the runner and therefore the guard.
    const trace = new Database(':memory:');
    runMigrations(trace, TRACE_MIGRATIONS);
    trace.prepare(BUMP).run();
    expect(() => runMigrations(trace, TRACE_MIGRATIONS)).toThrow(SCHEMA_NEWER_SENTENCE);
  });

  it('Postgres: migratePostgres refuses the same way', async () => {
    const d = await pgliteDriver();
    const owner = d.asOwner();
    await migratePostgres(owner);
    await owner.run(BUMP);
    await expect(migratePostgres(owner)).rejects.toThrow(SCHEMA_NEWER_SENTENCE);
    await d.close();
  });

  it('openDb / openTraceDb surface it (the daemon does not serve a newer schema)', () => {
    const path = join(dir, 'musterd.db');
    const raw = openDb(path);
    raw.prepare(BUMP).run();
    raw.close();
    expect(() => openDb(path)).toThrow(SCHEMA_NEWER_SENTENCE);
    const tracePath = join(dir, 'trace.db');
    const trace = openTraceDb(tracePath);
    trace.prepare(BUMP).run();
    trace.close();
    expect(() => openTraceDb(tracePath)).toThrow(SCHEMA_NEWER_SENTENCE);
  });
});
