import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';
import { sqliteDriver, type SqliteDriver } from './sqliteDriver.js';

export type { Database } from 'better-sqlite3';

/**
 * Open (or create) the database at `path` (or ':memory:'), set PRAGMAs, run migrations.
 * Pass ':memory:' for tests.
 */
export function openDb(path: string): Database.Database {
  if (path === ':memory:') return openMemory();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  if (path !== ':memory:') {
    // The db holds message bodies, credentials-adjacent audit rows and the whole team's traffic;
    // better-sqlite3 creates it with the process umask (644 on a stock mac — world-readable).
    // Tighten to owner-only on every open, not just create, so installs that predate this fix are
    // repaired the next time the daemon starts. WAL/SHM siblings carry the same bytes in flight,
    // and SQLite creates them with the same umask, so they get the same treatment.
    for (const suffix of ['', '-wal', '-shm']) {
      if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    }
  }
  return db;
}

/**
 * In-memory databases are clones of ONE migrated template per process (lane 01M3ZRQAGDDMTG6TA9T27D02N9,
 * goal ci-cost, 2026-10-03). `:memory:` is the test suite's store — every test opens one, and so does
 * every test daemon for its trace store — and replaying the ladder on each open measured 24.5 ms on
 * the laptop, ~9,500 times a CI run: the whole per-test fixed cost of the SQLite leg. Migrating once
 * and cloning the serialized bytes measured 0.27 ms, and a clone is a freshly migrated database in
 * every observable way (open.test.ts holds it to that: same schema objects, same version, same
 * pragmas, nothing shared between clones). WAL is not a mode an in-memory database can take, so the
 * only pragma a clone needs is foreign_keys.
 */
let memoryTemplate: Buffer | undefined;
/** How often the template was built and cloned in this process — a test seam, nothing else reads it. */
export const memoryTemplateStats = { builds: 0, clones: 0 };
function openMemory(): Database.Database {
  if (!memoryTemplate) {
    const seed = new Database(':memory:');
    seed.pragma('foreign_keys = ON');
    runMigrations(seed);
    memoryTemplate = seed.serialize();
    seed.close();
    memoryTemplateStats.builds++;
  }
  const db = new Database(memoryTemplate);
  db.pragma('foreign_keys = ON');
  memoryTemplateStats.clones++;
  return db;
}

/** The coordination store behind the async Driver (ADR 479): `openDb` + the SQLite driver. */
export function openDriver(path: string): SqliteDriver {
  return sqliteDriver(openDb(path));
}
