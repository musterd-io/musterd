import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { memoryTemplateStats, openDb } from './open.js';

/**
 * Lane 01M3ZRQAGDDMTG6TA9T27D02N9 (goal ci-cost, 2026-10-03): `openDb(':memory:')` replayed the whole
 * ladder on every open — 24.5 ms on the laptop, ~9,500 times a CI run — and that replay was the
 * SQLite leg's entire per-test fixed cost. The ladder now runs once per process into a template and
 * every later in-memory open is a clone (0.27 ms measured). The contract below is what a test may
 * rely on: a clone IS a freshly migrated database — same schema objects, same version, same
 * pragmas, and no shared state between two opens.
 */
describe("openDb(':memory:') serves clones of one migrated template", () => {
  it('builds the template once and clones it for every in-memory open', () => {
    const before = { ...memoryTemplateStats };
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    expect(memoryTemplateStats.builds).toBeLessThanOrEqual(before.builds + 1);
    expect(memoryTemplateStats.clones).toBe(before.clones + 2);
    a.close();
    b.close();
  });

  it('a clone is schema-identical to a database the ladder migrated directly, at the same version', () => {
    const direct = new Database(':memory:');
    direct.pragma('foreign_keys = ON');
    runMigrations(direct);
    const clone = openDb(':memory:');
    const objects = (db: Database.Database) =>
      db
        .prepare(
          "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
        )
        .all();
    expect(objects(clone)).toEqual(objects(direct));
    const version = (db: Database.Database) =>
      db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").pluck().get();
    expect(version(clone)).toBe(String(MIGRATIONS[MIGRATIONS.length - 1]!.version));
    expect(version(clone)).toBe(version(direct));
    expect(clone.pragma('foreign_keys', { simple: true })).toBe(1);
    direct.close();
    clone.close();
  });

  it('two clones share nothing: a write in one is invisible in the other', () => {
    const a = openDb(':memory:');
    const b = openDb(':memory:');
    a.prepare("INSERT INTO schema_meta (key, value) VALUES ('probe', '1')").run();
    expect(a.prepare("SELECT count(*) FROM schema_meta WHERE key = 'probe'").pluck().get()).toBe(1);
    expect(b.prepare("SELECT count(*) FROM schema_meta WHERE key = 'probe'").pluck().get()).toBe(0);
    const c = openDb(':memory:');
    expect(c.prepare("SELECT count(*) FROM schema_meta WHERE key = 'probe'").pluck().get()).toBe(0);
    a.close();
    b.close();
    c.close();
  });
});
