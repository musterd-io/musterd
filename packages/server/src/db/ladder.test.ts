import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { LADDER } from './ladder.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { migratePostgres } from './pg/migrate.js';
import { pgliteDriver } from './pgliteDriver.js';

const V81 = ['presence', 'inbox_cursors', 'seat_memory', 'seed_thread_entries'];

describe('the portable ladder (spec §12.2)', () => {
  it('every entry is portable SQL or a complete per-engine pair, versions ascend from 81', () => {
    let prev = 80;
    for (const m of LADDER) {
      expect(m.version).toBeGreaterThan(prev);
      prev = m.version;
      expect(Boolean(m.sql) !== Boolean(m.sqlite && m.postgres), `v${m.version}`).toBe(true);
    }
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(LADDER[LADDER.length - 1]!.version);
  });

  it('v83: the four member-owned tables carry team_id on both engines', async () => {
    const s = new Database(':memory:');
    runMigrations(s);
    for (const t of V81)
      expect(
        (s.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map((c) => c.name),
        t,
      ).toContain('team_id');
    const p = await pgliteDriver();
    const owner = p.asOwner();
    await migratePostgres(owner);
    for (const t of V81) {
      const cols = await owner.all<{ c: string; nullable: string }>(
        'SELECT column_name AS c, is_nullable AS nullable FROM information_schema.columns WHERE table_name = ?',
        [t],
      );
      const team = cols.find((c) => c.c === 'team_id');
      expect(team, t).toBeDefined();
      expect(team!.nullable, `${t}.team_id NOT NULL on Postgres`).toBe('NO');
    }
    await p.close();
  });

  it('v83 on SQLite backfills team_id from the owner and drops orphans', () => {
    const s = new Database(':memory:');
    s.pragma('foreign_keys = ON');
    // Run to v80, seed one member with a presence + cursor + memory, then apply v81.
    const legacy = MIGRATIONS.filter((m) => m.version <= 80);
    for (const m of legacy) m.up(s);
    s.exec(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('T','t','T',1,1)",
    );
    s.exec(
      "INSERT INTO members (id, team_id, name, kind, created_at, updated_at) VALUES ('M','T','m','agent',1,1)",
    );
    s.exec(
      "INSERT INTO presence (id, member_id, surface, status, last_seen_at, created_at) VALUES ('P','M','cli','online',1,1)",
    );
    s.exec("INSERT INTO seat_memory (member_id, headline, body, saved_at) VALUES ('M','h','b',1)");
    s.exec(
      "INSERT INTO inbox_cursors (member_id, last_read_message_id, last_read_ts, updated_at) VALUES ('M', NULL, 0, 1)",
    );
    s.exec("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '80')");
    expect(runMigrations(s)).toBe(83);
    expect(s.prepare('SELECT team_id FROM presence WHERE id = ?').get('P')).toEqual({
      team_id: 'T',
    });
    expect(s.prepare('SELECT team_id FROM seat_memory').get()).toEqual({ team_id: 'T' });
    expect(s.prepare('SELECT team_id FROM inbox_cursors').get()).toEqual({ team_id: 'T' });
  });
});
