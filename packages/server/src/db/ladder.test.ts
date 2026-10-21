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

  it('v116 scrubs historical policy copies in place on SQLite and Postgres', async () => {
    const marker = { $redacted: 'policy-secret' };
    const policy = {
      ask_slack_webhook: 'https://hooks.slack.test/ASK_SENTINEL',
      seeds_relay_url: 'https://relay.test/SEEDS_URL_SENTINEL',
      seeds_relay_token: 'SEEDS_TOKEN_SENTINEL',
      away_relay_url: 'wss://relay.test/AWAY_URL_SENTINEL',
      away_relay_token: 'AWAY_TOKEN_SENTINEL',
      slack_bot_token: 'SLACK_TOKEN_SENTINEL',
      doorbell: {
        slack_url: 'https://hooks.slack.test/DOORBELL_SLACK_SENTINEL',
        webhook_url: 'https://hooks.test/DOORBELL_WEBHOOK_SENTINEL',
      },
      ask_fallback_to_nonadmin: true,
    };
    const event = {
      kind: 'policy',
      team: 't',
      event: {
        id: 'audit-policy',
        ts: 10,
        actor: 'nick',
        action: 'policy.change',
        target: null,
        result: 'allow',
        detail: policy,
      },
      origin_node: 'N',
      origin_seq: 17,
    };
    const otherEvent = {
      kind: 'policy',
      team: 't',
      event: {
        id: 'audit-other',
        ts: 12,
        actor: 'nick',
        action: 'member.add',
        target: 'ada',
        result: 'allow',
        detail: { note: 'KEEP_SYNC_SENTINEL' },
      },
      origin_node: 'N',
      origin_seq: 18,
    };

    const sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    runMigrations(
      sqlite,
      MIGRATIONS.filter((m) => m.version <= 115),
    );
    sqlite.exec("INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('T','t',1,1)");
    sqlite.exec("INSERT INTO nodes (id, team_id, label) VALUES ('N','T','hub')");
    const insertSqlite = sqlite.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at,
         origin_node, origin_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertSqlite.run(
      'audit-policy',
      'T',
      10,
      'nick',
      'policy.change',
      null,
      'allow',
      JSON.stringify(policy),
      11,
      'N',
      17,
    );
    insertSqlite.run(
      'audit-other',
      'T',
      12,
      'nick',
      'member.add',
      null,
      'allow',
      '{"note":"KEEP_SENTINEL"}',
      13,
      'N',
      18,
    );
    sqlite
      .prepare(
        `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('sync-policy', 'T', 'N', 17, 9, JSON.stringify(event), 20);
    sqlite
      .prepare(
        `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('sync-other', 'T', 'N', 18, 10, JSON.stringify(otherEvent), 21);
    const sqliteAuditBefore = sqlite
      .prepare(
        'SELECT id, ts, actor, action, target, result, created_at, origin_node, origin_seq FROM audit ORDER BY id',
      )
      .all();
    const sqliteSyncBefore = sqlite
      .prepare(
        'SELECT id, team_id, origin_node, origin_seq, hub_seq, received_at FROM sync_log ORDER BY id',
      )
      .all();
    expect(runMigrations(sqlite)).toBe(126);
    expect(
      sqlite
        .prepare(
          'SELECT id, ts, actor, action, target, result, created_at, origin_node, origin_seq FROM audit ORDER BY id',
        )
        .all(),
    ).toEqual(sqliteAuditBefore);
    expect(
      sqlite
        .prepare(
          'SELECT id, team_id, origin_node, origin_seq, hub_seq, received_at FROM sync_log ORDER BY id',
        )
        .all(),
    ).toEqual(sqliteSyncBefore);
    const sqliteDetail = JSON.parse(
      sqlite.prepare('SELECT detail FROM audit WHERE id = ?').get('audit-policy')!.detail as string,
    );
    const sqlitePayload = JSON.parse(
      sqlite.prepare('SELECT payload FROM sync_log WHERE id = ?').get('sync-policy')!
        .payload as string,
    );
    expect(sqliteDetail).toMatchObject({
      ask_slack_webhook: marker,
      seeds_relay_url: marker,
      seeds_relay_token: marker,
      away_relay_url: marker,
      away_relay_token: marker,
      slack_bot_token: marker,
      doorbell: { slack_url: marker, webhook_url: marker },
      ask_fallback_to_nonadmin: true,
    });
    expect(JSON.stringify(sqlitePayload)).not.toContain('SENTINEL');
    expect(sqlite.prepare('SELECT detail FROM audit WHERE id = ?').get('audit-other')).toEqual({
      detail: '{"note":"KEEP_SENTINEL"}',
    });
    expect(
      JSON.parse(
        sqlite.prepare('SELECT payload FROM sync_log WHERE id = ?').get('sync-other')!
          .payload as string,
      ),
    ).toEqual(otherEvent);

    const p = await pgliteDriver();
    const owner = p.asOwner();
    await migratePostgres(owner);
    await owner.exec("UPDATE schema_meta SET value = '115' WHERE key = 'schema_version'");
    await owner.exec("INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('T','t',1,1)");
    await owner.exec("INSERT INTO nodes (id, team_id, label) VALUES ('N','T','hub')");
    await owner.run(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at,
         origin_node, origin_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'audit-policy',
        'T',
        10,
        'nick',
        'policy.change',
        null,
        'allow',
        JSON.stringify(policy),
        11,
        'N',
        17,
      ],
    );
    await owner.run(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at,
         origin_node, origin_seq) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        'audit-other',
        'T',
        12,
        'nick',
        'member.add',
        null,
        'allow',
        '{"note":"KEEP_SENTINEL"}',
        13,
        'N',
        18,
      ],
    );
    await owner.run(
      `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['sync-policy', 'T', 'N', 17, 9, JSON.stringify(event), 20],
    );
    await owner.run(
      `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['sync-other', 'T', 'N', 18, 10, JSON.stringify(otherEvent), 21],
    );
    const pgAuditBefore = await owner.all(
      'SELECT id, ts, actor, action, target, result, created_at, origin_node, origin_seq FROM audit ORDER BY id',
    );
    const pgSyncBefore = await owner.all(
      'SELECT id, team_id, origin_node, origin_seq, hub_seq, received_at FROM sync_log ORDER BY id',
    );
    expect(await migratePostgres(owner)).toBe(126);
    expect(
      await owner.all(
        'SELECT id, ts, actor, action, target, result, created_at, origin_node, origin_seq FROM audit ORDER BY id',
      ),
    ).toEqual(pgAuditBefore);
    expect(
      await owner.all(
        'SELECT id, team_id, origin_node, origin_seq, hub_seq, received_at FROM sync_log ORDER BY id',
      ),
    ).toEqual(pgSyncBefore);
    const pgDetail = JSON.parse(
      (await owner.get<{ detail: string }>('SELECT detail FROM audit WHERE id = ?', [
        'audit-policy',
      ]))!.detail,
    );
    const pgPayload = JSON.parse(
      (await owner.get<{ payload: string }>('SELECT payload FROM sync_log WHERE id = ?', [
        'sync-policy',
      ]))!.payload,
    );
    expect(pgDetail).toMatchObject({
      ask_slack_webhook: marker,
      seeds_relay_url: marker,
      seeds_relay_token: marker,
      away_relay_url: marker,
      away_relay_token: marker,
      slack_bot_token: marker,
      doorbell: { slack_url: marker, webhook_url: marker },
      ask_fallback_to_nonadmin: true,
    });
    expect(JSON.stringify(pgPayload)).not.toContain('SENTINEL');
    expect(await owner.get('SELECT detail FROM audit WHERE id = ?', ['audit-other'])).toEqual({
      detail: '{"note":"KEEP_SENTINEL"}',
    });
    expect(
      JSON.parse(
        (await owner.get<{ payload: string }>('SELECT payload FROM sync_log WHERE id = ?', [
          'sync-other',
        ]))!.payload,
      ),
    ).toEqual(otherEvent);
    await p.close();
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
    expect(runMigrations(s)).toBe(126);
    expect(s.prepare('SELECT team_id FROM presence WHERE id = ?').get('P')).toEqual({
      team_id: 'T',
    });
    expect(s.prepare('SELECT team_id FROM seat_memory').get()).toEqual({ team_id: 'T' });
    expect(s.prepare('SELECT team_id FROM inbox_cursors').get()).toEqual({ team_id: 'T' });
  });

  it('v86: members.style_prefs and presence.style_epoch exist (ADR 514; Postgres parity is drift.test)', () => {
    const s = new Database(':memory:');
    runMigrations(s);
    const memberCols = s.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
    const presenceCols = s.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
    expect(memberCols).toContain('style_prefs');
    expect(presenceCols).toContain('style_epoch');
  });

  it('v103 on SQLite keeps every existing tool-call row as stdio and keys the rail (ADR 640)', () => {
    const s = new Database(':memory:');
    s.pragma('foreign_keys = ON');
    runMigrations(
      s,
      MIGRATIONS.filter((m) => m.version <= 102),
    );
    s.exec(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('T','t','T',1,1)",
    );
    s.exec(
      `INSERT INTO tool_call_stats (team_id, seat, role, tool, outcome, bucket_start, calls,
         total_duration_ms, max_duration_ms) VALUES ('T','ada','backend','team_send','ok',3600000,4,40,20)`,
    );
    expect(runMigrations(s)).toBe(126);
    expect(s.prepare('SELECT rail, calls, role FROM tool_call_stats').get()).toEqual({
      rail: 'stdio',
      calls: 4,
      role: 'backend',
    });
    // The same seat, tool, outcome and hour on the other rail is a second row, not a conflict.
    s.exec(
      `INSERT INTO tool_call_stats (team_id, seat, role, rail, tool, outcome, bucket_start, calls,
         total_duration_ms, max_duration_ms) VALUES ('T','ada','backend','remote','team_send','ok',3600000,1,90,90)`,
    );
    expect(s.prepare('SELECT COUNT(*) AS n FROM tool_call_stats').get()).toEqual({ n: 2 });
    const idx = s
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tool_call_stats'",
      )
      .pluck()
      .all();
    expect(idx).toContain('idx_tool_call_stats_team_bucket');
  });

  it('v104 admits a muse presence, keeps the lease, and still refuses an unknown surface', () => {
    const s = new Database(':memory:');
    s.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS) {
      if (m.version > 103) break;
      m.up(s);
    }
    s.exec(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('T','t','T',1,1)",
    );
    s.exec(
      "INSERT INTO members (id, team_id, name, kind, created_at, updated_at) VALUES ('M','T','m','agent',1,1)",
    );
    s.exec(
      `INSERT INTO presence (
         id, member_id, team_id, surface, status, conn_id, last_seen_at, created_at,
         held_until, provenance, workspace, driver, model, build, epoch, wake_lease,
         model_source, node, guidance_epoch, style_epoch
       ) VALUES (
         'P','M','T','cli','online','c1',1,1,
         9,'session','~/w','nick','gpt','b1',3,'lease',
         'observed','n1',4,'abcdef01'
       )`,
    );
    s.exec(
      `INSERT INTO session_leases (id, team_id, member_id, presence_id, token_hash, expires_at, created_at)
       VALUES ('L','T','M','P','hash',99,1)`,
    );
    s.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '103') ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run();

    expect(runMigrations(s)).toBe(126);

    expect(s.prepare('SELECT * FROM presence WHERE id = ?').get('P')).toMatchObject({
      id: 'P',
      member_id: 'M',
      team_id: 'T',
      surface: 'cli',
      conn_id: 'c1',
      held_until: 9,
      provenance: 'session',
      workspace: '~/w',
      driver: 'nick',
      model: 'gpt',
      build: 'b1',
      epoch: 3,
      wake_lease: 'lease',
      model_source: 'observed',
      node: 'n1',
      guidance_epoch: 4,
      style_epoch: 'abcdef01',
    });
    expect(s.prepare('SELECT presence_id FROM session_leases WHERE id = ?').get('L')).toEqual({
      presence_id: 'P',
    });
    expect(() =>
      s
        .prepare(
          `INSERT INTO presence (id, member_id, team_id, surface, status, last_seen_at, created_at)
           VALUES ('Pm','M','T','muse','online',1,1)`,
        )
        .run(),
    ).not.toThrow();
    expect(() =>
      s
        .prepare(
          `INSERT INTO presence (id, member_id, team_id, surface, status, last_seen_at, created_at)
           VALUES ('Px','M','T','holodeck','online',1,1)`,
        )
        .run(),
    ).toThrow(/CHECK constraint failed/);
    const idx = s
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'presence'")
      .pluck()
      .all();
    expect(idx).toEqual(
      expect.arrayContaining([
        'idx_presence_member',
        'idx_presence_last_seen',
        'idx_presence_node',
        'idx_presence_team',
      ]),
    );
    expect(s.pragma('foreign_key_check')).toEqual([]);

    // A rewind replays the rebuild. The lease must still be there: fkOff is the whole point.
    s.prepare("UPDATE schema_meta SET value = '103' WHERE key = 'schema_version'").run();
    expect(runMigrations(s)).toBe(126);
    expect(s.prepare('SELECT presence_id FROM session_leases WHERE id = ?').get('L')).toEqual({
      presence_id: 'P',
    });
    expect(s.prepare('SELECT surface FROM presence WHERE id = ?').get('Pm')).toEqual({
      surface: 'muse',
    });
    expect(s.pragma('foreign_key_check')).toEqual([]);
  });

  it('v104 on Postgres replaces the surface CHECK and admits muse', async () => {
    const p = await pgliteDriver();
    const owner = p.asOwner();
    await migratePostgres(owner);
    await owner.exec(
      "INSERT INTO teams (id, slug, display, created_at, updated_at) VALUES ('T','t','T',1,1)",
    );
    await owner.exec(
      "INSERT INTO members (id, team_id, name, kind, created_at, updated_at) VALUES ('M','T','m','agent',1,1)",
    );
    await owner.exec(
      `INSERT INTO presence (id, member_id, team_id, surface, status, last_seen_at, created_at)
       VALUES ('Pm','M','T','muse','online',1,1)`,
    );
    await expect(
      owner.exec(
        `INSERT INTO presence (id, member_id, team_id, surface, status, last_seen_at, created_at)
         VALUES ('Px','M','T','holodeck','online',1,1)`,
      ),
    ).rejects.toThrow(/check constraint/i);
    const def = await owner.get<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c
         JOIN pg_class r ON r.oid = c.conrelid
        WHERE r.relname = 'presence' AND c.conname = 'presence_surface_check'`,
    );
    expect(def?.def).toContain('muse');
    await p.close();
  });
});
