import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CONSTRUCTS, inventory } from './pglite-dialect-inventory.mjs';

describe('pglite dialect inventory', () => {
  it('counts each SQLite-only construct and every better-sqlite3 call site, skipping tests', () => {
    const root = mkdtempSync(join(tmpdir(), 'inv-'));
    mkdirSync(join(root, 'store'));
    writeFileSync(
      join(root, 'store', 'a.ts'),
      [
        "import Database from 'better-sqlite3';",
        "db.prepare(\"SELECT json_extract(detail, '$.x') FROM t\").all();",
        'db.exec("PRAGMA foreign_keys = ON");',
        'db.transaction(() => db.prepare("INSERT OR IGNORE INTO t VALUES (?)").run(1))();',
        'db.pragma("journal_mode = WAL");',
        'const n = db.prepare("DELETE FROM t").run().changes;',
      ].join('\n'),
    );
    writeFileSync(join(root, 'store', 'a.test.ts'), 'db.prepare("PRAGMA x")');
    const r = inventory(root);
    expect(r.files).toBe(1);
    expect(r.byConstruct.json_extract).toBe(1);
    expect(r.byConstruct.PRAGMA).toBe(1);
    expect(r.byConstruct['INSERT OR IGNORE']).toBe(1);
    expect(r.byConstruct['.prepare(']).toBe(3);
    expect(r.byConstruct['.exec(']).toBe(1);
    expect(r.byConstruct['.transaction(']).toBe(1);
    expect(r.byConstruct['.pragma(']).toBe(1);
    expect(r.byConstruct['.changes']).toBe(1);
    expect(r.byFile['store/a.ts']).toBeGreaterThan(0);
  });

  it('pins the construct list so the report cannot silently drop one', () => {
    expect(CONSTRUCTS).toEqual([
      'json_extract',
      'json_each',
      'PRAGMA',
      '.pragma(',
      'INSERT OR IGNORE',
      'INSERT OR REPLACE',
      'AUTOINCREMENT',
      'INTEGER PRIMARY KEY',
      'strftime',
      'datetime(',
      'unixepoch',
      'GLOB',
      'iif(',
      'COLLATE NOCASE',
      'last_insert_rowid',
      'ON CONFLICT',
      'RETURNING',
      '.prepare(',
      '.exec(',
      '.transaction(',
      '.changes',
    ]);
  });
});
