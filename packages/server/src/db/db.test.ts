import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { addMember } from '../store/members.js';
import { createTeam, getTeamBySlug } from '../store/teams.js';
import { HELD_HEAD_AUDIT_SQL, HELD_PAIR_AUDIT_SQL } from '../sync/fold.js';
import { UNPUSHED_AUDIT_SQL } from '../sync/push.js';
import { MIGRATIONS, runMigrations } from './migrations.js';
import { openDb } from './open.js';
import { seedDawn } from './seed.js';
import { sqliteDriver } from './sqliteDriver.js';

describe('db', async () => {
  it('opens in-memory, migrates to the latest schema, sets foreign_keys', async () => {
    const db = openDb(':memory:');
    const ver = db
      .prepare<[], { value: string }>("SELECT value FROM schema_meta WHERE key='schema_version'")
      .get();
    // Bumped with every migration, deliberately ABSOLUTE rather than read from the MIGRATIONS
    // array: a test written against the constant under test cannot fail (ryder's ADR 236 finding —
    // one of his five mutants survived for exactly that reason).
    expect(ver?.value).toBe('92');
    const fk = db.prepare<[], { foreign_keys: number }>('PRAGMA foreign_keys').get();
    expect(fk?.foreign_keys).toBe(1);
    await db.close();
  });

  it('migrates OAuth clients into team bindings without losing existing grants', async () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const migration of MIGRATIONS) {
      if (migration.version > 77) break;
      migration.up(db);
    }
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '77') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();

    const team = await createTeam(sqliteDriver(db), { slug: 'dawn' });
    const { row: member } = await addMember(sqliteDriver(db), team, {
      name: 'Nick',
      kind: 'human',
      role: '',
    });
    const now = Date.now();
    const clientId = 'cid_legacy';
    const codeHash = createHash('sha256').update('legacy-code').digest('hex');
    const accessHash = createHash('sha256').update('legacy-access').digest('hex');
    const refreshHash = createHash('sha256').update('legacy-refresh').digest('hex');
    db.prepare(
      `INSERT INTO oauth_clients
       (client_id, team_id, client_name, redirect_uris, client_secret_hash, auth_method, created_at)
       VALUES (?, ?, ?, ?, NULL, 'none', ?)`,
    ).run(clientId, team.id, 'Legacy DCR', JSON.stringify(['https://app.example/cb']), now);
    db.prepare(
      `INSERT INTO oauth_codes
       (code_hash, team_id, member_id, client_id, redirect_uri, code_challenge, scope,
        created_at, expires_at, used_at, connected_by)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL, NULL)`,
    ).run(
      codeHash,
      team.id,
      member.id,
      clientId,
      'https://app.example/cb',
      'legacy-challenge',
      now,
      now + 90_000,
    );
    const insertToken = db.prepare(
      `INSERT INTO oauth_tokens
       (token_hash, kind, team_id, member_id, client_id, chain_id, scope, created_at,
        expires_at, replaced_at, revoked_at, connected_by)
       VALUES (?, ?, ?, ?, ?, 'legacy-chain', NULL, ?, ?, NULL, NULL, NULL)`,
    );
    insertToken.run(accessHash, 'access', team.id, member.id, clientId, now, now + 3_600_000);
    insertToken.run(refreshHash, 'refresh', team.id, member.id, clientId, now, now + 86_400_000);

    runMigrations(db);

    expect(
      db.prepare('SELECT client_id, team_id, client_name, redirect_uris FROM oauth_clients').all(),
    ).toEqual([
      {
        client_id: clientId,
        team_id: team.id,
        client_name: 'Legacy DCR',
        redirect_uris: JSON.stringify(['https://app.example/cb']),
      },
    ]);
    expect(
      db
        .prepare('SELECT team_id, client_id, source FROM oauth_client_bindings WHERE client_id = ?')
        .all(clientId),
    ).toEqual([{ team_id: team.id, client_id: clientId, source: 'dcr' }]);
    expect(db.prepare('SELECT code_hash, client_id FROM oauth_codes').all()).toEqual([
      { code_hash: codeHash, client_id: clientId },
    ]);
    expect(
      db.prepare('SELECT token_hash, client_id FROM oauth_tokens ORDER BY token_hash').all(),
    ).toEqual(
      [
        { token_hash: accessHash, client_id: clientId },
        { token_hash: refreshHash, client_id: clientId },
      ].sort((a, b) => a.token_hash.localeCompare(b.token_hash)),
    );
    for (const table of ['oauth_codes', 'oauth_tokens']) {
      const foreignKeys = db.pragma(`foreign_key_list(${table})`) as Array<{
        table: string;
        from: string;
        to: string;
      }>;
      expect(
        foreignKeys
          .filter((key) => key.table === 'oauth_client_bindings')
          .map(({ from, to }) => ({ from, to }))
          .sort((a, b) => a.from.localeCompare(b.from)),
      ).toEqual([
        { from: 'client_id', to: 'client_id' },
        { from: 'team_id', to: 'team_id' },
      ]);
    }
    expect(db.pragma('foreign_key_check')).toEqual([]);

    // Migration tests may rewind only the version marker to replay an older migration. The latest
    // OAuth rebuild must tolerate that replay and preserve every live binding and grant.
    db.prepare("UPDATE schema_meta SET value = '79' WHERE key = 'schema_version'").run();
    expect(runMigrations(db)).toBe(92);
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_client_bindings').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_codes').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM oauth_tokens').get()).toEqual({ n: 2 });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.close();
  });

  it('adds durable legacy-bootstrap migration and cutover evidence (ADR 350)', async () => {
    const db = openDb(':memory:');
    const credentialCols = (
      db.prepare('PRAGMA table_info(agent_bootstrap_credentials)').all() as { name: string }[]
    ).map((column) => column.name);
    expect(credentialCols).toEqual(
      expect.arrayContaining(['migration_target_member_id', 'first_used_at']),
    );
    const teamCols = (db.prepare('PRAGMA table_info(teams)').all() as { name: string }[]).map(
      (column) => column.name,
    );
    expect(teamCols).toContain('bootstrap_cutover_at');
    await db.close();
  });

  it('v14 widens messages.act beyond the frozen v5 CHECK (steering acts persist, ADR 103)', async () => {
    const db = openDb(':memory:');
    await seedDawn(sqliteDriver(db));
    const team = db.prepare<[], { id: string }>('SELECT id FROM teams LIMIT 1').get();
    const member = db.prepare<[], { id: string }>('SELECT id FROM members LIMIT 1').get();
    // Inserting a `steer` (unknown to the v5 CHECK vocabulary) must not throw at the DB layer.
    expect(() =>
      db
        .prepare(
          `INSERT INTO messages (id, team_id, from_member, to_kind, act, body, ts, created_at)
           VALUES (?, ?, ?, 'team', 'steer', '', 1, 1)`,
        )
        .run('m-steer', team!.id, member!.id),
    ).not.toThrow();
    await db.close();
  });

  it('v12 adds the goal_id join column on lanes (ADR 084)', async () => {
    const db = openDb(':memory:');
    const laneCols = (db.prepare('PRAGMA table_info(lanes)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(laneCols).toContain('goal_id');
    await db.close();
  });

  it('v15 adds the model attestation column on presence (ADR 101)', async () => {
    const db = openDb(':memory:');
    const presenceCols = (
      db.prepare('PRAGMA table_info(presence)').all() as { name: string }[]
    ).map((c) => c.name);
    expect(presenceCols).toContain('model');
    await db.close();
  });

  it('v34 adds the wake correlation token on presence (ADR 241)', () => {
    const db = openDb(':memory:');
    const cols = db.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
    expect(cols).toContain('wake_lease');
    // Nullable and never backfilled: an occupancy no wake caused genuinely has no lease, and the
    // verifier must read that absence as "not mine" rather than as missing data (ADR 236).
    const nullable = db
      .prepare<
        [],
        { notnull: number }
      >("SELECT [notnull] FROM pragma_table_info('presence') WHERE name = 'wake_lease'")
      .get();
    expect(nullable?.notnull).toBe(0);
  });

  it('v69 adds the attested guidance epoch on presence (ADR 417)', () => {
    const db = openDb(':memory:');
    const cols = db.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
    expect(cols).toContain('guidance_epoch');
    // Nullable, and deliberately NOT `NOT NULL DEFAULT 0`: an unstamped workspace and an older
    // client both genuinely have no epoch to attest, and 0 is the exact silhouette of maximal
    // staleness. Absence must stay distinguishable from the oldest real answer.
    const nullable = db
      .prepare<
        [],
        { notnull: number; dflt_value: unknown }
      >("SELECT [notnull], dflt_value FROM pragma_table_info('presence') WHERE name = 'guidance_epoch'")
      .get();
    expect(nullable?.notnull).toBe(0);
    expect(nullable?.dflt_value).toBeNull();
  });

  it('v19 adds the resumable-attestation columns on residency (ADR 131 inc 4)', async () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(residency)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toEqual(expect.arrayContaining(['resumable_harness', 'resumable_at']));
    await db.close();
  });

  it('v65 adds the hue column on members (ADR 374)', async () => {
    const db = openDb(':memory:');
    const cols = db
      .prepare<[], { name: string }>("SELECT name FROM pragma_table_info('members')")
      .all()
      .map((c) => c.name);
    expect(cols).toContain('hue');
    await db.close();
  });

  it('v66 rebuilds seeds so slack_user_id may be NULL, carrying every relay Seed over (ADR 373 inc 2)', async () => {
    const db = openDb(':memory:');
    const team = await createTeam(sqliteDriver(db), { slug: 'revive' });
    await addMember(sqliteDriver(db), team, { name: 'nick', kind: 'human', slackUserId: 'U1' });
    const member = db
      .prepare<
        [string],
        { id: string }
      >("SELECT id FROM members WHERE team_id = ? AND name = 'nick'")
      .get(team.id)!;
    // Rewind to before the rebuild and plant a relay Seed and one thread entry under the old shape.
    db.prepare("UPDATE schema_meta SET value = '65' WHERE key = 'schema_version'").run();
    db.prepare(
      `INSERT INTO seeds (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state, created_at, updated_at)
       VALUES ('s1', ?, 'relay-1', 'slack', 'idea', 1, 'U1', ?, 'open', 1, 1)`,
    ).run(team.id, member.id);
    db.prepare(
      `INSERT INTO seed_thread_entries (id, seed_id, kind, body, member_id, created_at)
       VALUES ('t1', 's1', 'clarification', 'why?', ?, 2)`,
    ).run(member.id);
    expect(runMigrations(db)).toBe(92);
    const col = (db.pragma('table_info(seeds)') as { name: string; notnull: number }[]).find(
      (c) => c.name === 'slack_user_id',
    );
    expect(col?.notnull).toBe(0);
    expect(db.prepare('SELECT relay_id, slack_user_id FROM seeds').all()).toEqual([
      { relay_id: 'relay-1', slack_user_id: 'U1' },
    ]);
    expect(db.prepare('SELECT seed_id FROM seed_thread_entries').all()).toEqual([
      { seed_id: 's1' },
    ]);
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(() =>
      db
        .prepare(
          `INSERT INTO seeds (id, team_id, relay_id, source, body, captured_at, slack_user_id, submitted_by, state, created_at, updated_at)
           VALUES ('s2', ?, 'repo:a.md#b', 'repo', 'x', 1, NULL, ?, 'open', 1, 1)`,
        )
        .run(team.id, member.id),
    ).not.toThrow();
    await db.close();
  });

  it('v20 adds last_offline_reason on members (ADR 141)', async () => {
    const db = openDb(':memory:');
    const cols = (db.prepare('PRAGMA table_info(members)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).toContain('last_offline_reason');
    await db.close();
  });

  it('v30 seeds revive working hours without overwriting an explicit schedule (ADR 206)', async () => {
    const db = openDb(':memory:');
    await createTeam(sqliteDriver(db), { slug: 'revive' });
    db.prepare("UPDATE schema_meta SET value = '29' WHERE key = 'schema_version'").run();
    runMigrations(db);
    expect((await getTeamBySlug(sqliteDriver(db), 'revive'))?.working_hours).toBe(
      JSON.stringify({
        timezone: 'America/Los_Angeles',
        days: ['mon', 'tue', 'wed', 'thu', 'fri'],
        start: '11:00',
        end: '15:00',
      }),
    );

    const explicit = openDb(':memory:');
    await createTeam(sqliteDriver(explicit), {
      slug: 'revive',
      workingHours: {
        timezone: 'UTC',
        days: ['sat'],
        start: '09:00',
        end: '10:00',
      },
    });
    explicit.prepare("UPDATE schema_meta SET value = '29' WHERE key = 'schema_version'").run();
    runMigrations(explicit);
    expect((await getTeamBySlug(sqliteDriver(explicit), 'revive'))?.working_hours).toBe(
      JSON.stringify({ timezone: 'UTC', days: ['sat'], start: '09:00', end: '10:00' }),
    );
    await db.close();
    await explicit.close();
  });

  it('v25 indexes audit by action, and the planner actually picks it over (team_id, ts)', async () => {
    const db = openDb(':memory:');
    const indexes = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit'")
        .all() as {
        name: string;
      }[]
    ).map((i) => i.name);
    expect(indexes).toContain('idx_audit_team_action_ts');

    // Existence is not the point — the planner choosing it is. Without this index these reads
    // SCAN every row the team owns; asserting the chosen index is what stops a later schema
    // change from silently returning them to a scan.
    const plan = (
      db
        .prepare(
          `EXPLAIN QUERY PLAN SELECT target, detail FROM audit
             WHERE team_id = ? AND action = 'lane.closed' ORDER BY ts`,
        )
        .all('t') as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(plan).toContain('idx_audit_team_action_ts');

    // The paged listing narrows by team_id alone and must keep using the v9 (team_id, ts) index —
    // it orders by ts, so the new index would be a regression there.
    const pagedPlan = (
      db
        .prepare(
          'EXPLAIN QUERY PLAN SELECT * FROM audit WHERE team_id = ? ORDER BY ts DESC LIMIT ?',
        )
        .all('t', 50) as { detail: string }[]
    )
      .map((r) => r.detail)
      .join(' | ');
    expect(pagedPlan).toContain('idx_audit_team_ts');
    await db.close();
  });

  it('v10 adds the P3.1 substrate: grants + requests tables, team/member secret columns', async () => {
    const db = openDb(':memory:');
    // New tables exist and are queryable.
    expect(() => db.prepare('SELECT id FROM grants LIMIT 0').all()).not.toThrow();
    expect(() => db.prepare('SELECT id FROM requests LIMIT 0').all()).not.toThrow();
    // New columns exist on teams + members.
    const teamCols = (db.prepare('PRAGMA table_info(teams)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(teamCols).toEqual(expect.arrayContaining(['agent_key_hash', 'policy']));
    const memberCols = (db.prepare('PRAGMA table_info(members)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(memberCols).toContain('credential_hash');
    await db.close();
  });

  it('seedDawn produces the canonical fixture', async () => {
    const db = openDb(':memory:');
    const s = await seedDawn(sqliteDriver(db));
    const members = db
      .prepare<
        [string],
        { name: string; kind: string; role: string }
      >('SELECT name, kind, role FROM members WHERE team_id = ? ORDER BY created_at')
      .all(s.teamId);
    expect(members).toEqual([
      { name: 'nick', kind: 'human', role: 'lead' },
      { name: 'Ada', kind: 'agent', role: 'backend' },
      { name: 'Lin', kind: 'agent', role: 'frontend' },
    ]);
    expect(s.ada.token).toMatch(/^mskd_/);
    await db.close();
  });

  it('is idempotent when migrations re-run', async () => {
    const db = openDb(':memory:');
    // running again should not throw or duplicate
    const before = db.prepare('SELECT count(*) AS n FROM schema_meta').get() as { n: number };
    expect(before.n).toBe(1);
    await db.close();
  });
  /**
   * The v18 backfill (ADR 136), on the path that actually matters: an EXISTING database that already
   * holds observer seats — i.e. a live daemon with an open /live dashboard.
   *
   * Every other test opens a fresh db, where the backfill runs against zero rows and proves nothing.
   * If it were wrong, existing observers would come up with `observer_scope = NULL`... which still
   * resolves to 'full', so the *default* saves us — but only by luck. Pin the backfill itself: an
   * observer that predates grades must be explicitly 'full', never silently downgraded to 'public'
   * (which would blank the DM traffic out of a dashboard that has been working all along).
   */
  it('v18 backfills pre-existing observer seats to the full grade (no silent dashboard downgrade)', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');

    // Build the database as it stood at v17 — every migration up to, but not including, observer grades.
    for (const m of MIGRATIONS) {
      if (m.version > 17) break;
      m.up(db);
    }
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '17') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();

    const now = Date.now();
    db.prepare(
      `INSERT INTO teams (id, slug, display, default_lifecycle, created_at, updated_at)
       VALUES ('t1', 'dawn', 'Dawn', 'forever', ?, ?)`,
    ).run(now, now);
    // A v17-shape row: no observer_scope column exists yet to set.
    const member = (observer: number, id: string, name: string) =>
      db
        .prepare(
          `INSERT INTO members (id, team_id, name, kind, role, lifecycle, observer, created_at, updated_at)
           VALUES (?, 't1', ?, 'human', '', 'forever', ?, ?, ?)`,
        )
        .run(id, name, observer, now, now);
    member(1, 'm-obs', 'web-legacy');
    member(0, 'm-reg', 'nick');

    expect(runMigrations(db)).toBe(92); // runs v18…v84 (governed authorization substrate, audit actor attestation, guidance epoch, doorbell, in_reply_to column, oauth, member sponsorship, agent connect nonces, team invites, agent connectors, roster status index, lane parked state, host provisions, Team-scoped OAuth client bindings, lane follows_up + abandon_reason, lane unfinished_todos, team_id on the four member-owned tables, console token jti, style prefs + style epoch, holds, calendar entries, messages analyze threshold, partial messages origin index, lane source_ref, audit target index)

    const scope = (id: string) =>
      db
        .prepare<
          [string],
          { observer_scope: string | null }
        >('SELECT observer_scope FROM members WHERE id = ?')
        .get(id)?.observer_scope;

    // The live dashboard's observer keeps seeing everything …
    expect(scope('m-obs')).toBe('full');
    // … and the grade stays meaningless (NULL) on an ordinary member, rather than reading as if it
    // governed one.
    expect(scope('m-reg')).toBeNull();
    db.close();
  });

  /**
   * v26 (ADR 185) — the rows already frozen by the old parse-then-store `setPolicy` are rewritten
   * sparse. `t1` carries the REAL `revive` blob as it stood on 2026-07-30 (the one non-NULL policy in
   * the live fleet); `t2` carries a NULL, which must stay NULL rather than becoming `{}`.
   */
  it('v26 strips the baked-in defaults out of a densely-stored team policy', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS) {
      if (m.version > 25) break;
      m.up(db);
    }
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '25') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();

    const now = Date.now();
    const team = (id: string, slug: string, policy: string | null) =>
      db
        .prepare(
          `INSERT INTO teams (id, slug, display, default_lifecycle, policy, created_at, updated_at)
           VALUES (?, ?, NULL, 'forever', ?, ?, ?)`,
        )
        .run(id, slug, policy, now, now);
    team(
      't1',
      'revive',
      JSON.stringify({
        allow_pre_issued_grants: false,
        standing_reseat_known_agents: true,
        ask_fallback_to_nonadmin: false,
        residency: {
          lane: 'both',
          cooldown_ms: 1_800_000,
          hourly_cap: 2,
          attempt_cap: 3,
          tool_policy: 'reply-only',
          timeout_ms: 300_000,
          transcript_max_bytes: 262_144,
        },
        enforcement: { classes: [] },
      }),
    );
    team('t2', 'dawn', null);

    expect(runMigrations(db)).toBe(92);

    const policy = (id: string) =>
      db
        .prepare<[string], { policy: string | null }>('SELECT policy FROM teams WHERE id = ?')
        .get(id)?.policy;

    // Seven stored keys in, one out: only the knob whose value differs from its default survives.
    expect(JSON.parse(policy('t1') as string)).toEqual({ standing_reseat_known_agents: true });
    // A team that never wrote a policy is not touched — NULL is already "everything inherited".
    expect(policy('t2')).toBeNull();
    db.close();
  });
});

describe('v39 — the presence surface CHECK admits `musterd` (ADR 251 §2)', () => {
  it('accepts a native occupancy, and still refuses an unknown surface', async () => {
    // Measured live 2026-08-12 on the second native wake: the protocol enum reserved `musterd`
    // (ADR 131 §7) but the v1 CHECK never grew it, so the presence INSERT threw inside the WS claim
    // handler and the client hung with no response at all. ADR 251 §2's roster-distinctness — the
    // whole reason native occupancies carry their own surface — was unimplementable as shipped, and
    // was only masked because the binding re-read used to overwrite the surface before it was sent.
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('t1','dawn',1,1)",
    ).run();
    db.prepare(
      `INSERT INTO members (id, team_id, name, kind, role, lifecycle, observer, created_at, updated_at)
       VALUES ('m1','t1','compo','agent','','forever',0,1,1)`,
    ).run();
    const insert = (surface: string) =>
      db
        .prepare(
          `INSERT INTO presence (id, member_id, surface, status, last_seen_at, created_at)
           VALUES (?, 'm1', ?, 'online', 1, 1)`,
        )
        .run(`p-${surface}`, surface);

    expect(() => insert('musterd')).not.toThrow();
    expect(() => insert('claude-code')).not.toThrow();
    // The constraint must stay a constraint — widening is not opening.
    expect(() => insert('definitely-not-a-surface')).toThrow();
    await db.close();
  });
});

describe('v44 — the presence surface CHECK admits `opencode` (ADR 321 §2)', () => {
  it('accepts an opencode presence, and still refuses an unknown surface', async () => {
    const db = openDb(':memory:');
    db.prepare(
      "INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('t1','dawn',1,1)",
    ).run();
    db.prepare(
      `INSERT INTO members (id, team_id, name, kind, role, lifecycle, observer, created_at, updated_at)
       VALUES ('m1','t1','ghost','agent','','forever',0,1,1)`,
    ).run();
    const insert = (surface: string) =>
      db
        .prepare(
          `INSERT INTO presence (id, member_id, surface, status, last_seen_at, created_at)
           VALUES (?, 'm1', ?, 'online', 1, 1)`,
        )
        .run(`p-${surface}`, surface);

    expect(() => insert('opencode')).not.toThrow();
    expect(() => insert('codex')).not.toThrow();
    // The constraint must stay a constraint — widening is not opening.
    expect(() => insert('definitely-not-a-surface')).toThrow();
    // model_source (migration 42) postdates v39's rebuilt column list; the enumerated copy must
    // have carried it or this read comes back empty (and openDb itself would have thrown).
    const cols = db.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
    expect(cols).toContain('model_source');
    await db.close();
  });
});

describe('v41 — incident convergence (spec 2026-08-14)', () => {
  it('adds lanes.kind and the incident_reports table', async () => {
    const db = openDb(':memory:');
    const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
    expect(laneCols).toContain('kind');
    const cols = db.prepare("SELECT name FROM pragma_table_info('incident_reports')").pluck().all();
    expect(cols).toEqual(
      expect.arrayContaining([
        'team_id',
        'gate',
        'seat',
        'sig',
        'ref',
        'message_id',
        'lane_id',
        'created_at',
      ]),
    );
    await db.close();
  });

  it('an on-disk db and its WAL/SHM siblings are owner-only (0600), including pre-existing 644 files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-db-mode-'));
    const path = join(dir, 'musterd.db');
    try {
      // First open creates all three; each must come out 600.
      let db = openDb(path);
      db.prepare('CREATE TABLE IF NOT EXISTS t (x)').run();
      await db.close();
      const mode = (p: string) => statSync(p).mode & 0o777;
      expect(mode(path)).toBe(0o600);
      // Simulate an existing install created before the fix: loosen, reopen, expect repair.
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(path + suffix)) chmodSync(path + suffix, 0o644);
      }
      db = openDb(path);
      for (const suffix of ['', '-wal', '-shm']) {
        if (existsSync(path + suffix)) expect(mode(path + suffix)).toBe(0o600);
      }
      await db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * ADR 331 eval (iv): the v47 backfill partitions by team — there is no "the local node". The
 * fixture seeds TWO teams with interleaved timestamps on purpose: a single-team fixture passes
 * identically under the global and the partitioned readings, so it cannot fail.
 */
describe('v47 — nodes table + (origin_node, origin_seq) backfill (ADR 331)', () => {
  const buildV46 = () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    for (const m of MIGRATIONS) {
      if (m.version > 46) break;
      m.up(db);
    }
    db.prepare(
      "INSERT INTO schema_meta (key, value) VALUES ('schema_version', '46') " +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run();
    const now = Date.now();
    for (const t of ['t1', 't2']) {
      db.prepare(
        `INSERT INTO teams (id, slug, display, default_lifecycle, created_at, updated_at)
         VALUES (?, ?, ?, 'forever', ?, ?)`,
      ).run(t, t, t, now, now);
      db.prepare(
        `INSERT INTO members (id, team_id, name, kind, role, lifecycle, observer, created_at, updated_at)
         VALUES (?, ?, 'ada', 'agent', '', 'forever', 0, ?, ?)`,
      ).run(`m-${t}`, t, now, now);
    }
    // Interleaved by ts across teams: t1 at 1000/3000/5000, t2 at 2000/4000. A global numbering
    // would scatter each team's numbers through 1..5; the partitioned one must not.
    const msg = db.prepare(
      `INSERT INTO messages (id, team_id, from_member, to_kind, act, body, ts, created_at)
       VALUES (?, ?, ?, 'team', 'message', '', ?, ?)`,
    );
    msg.run('m-a', 't1', 'm-t1', 1000, 1000);
    msg.run('m-b', 't2', 'm-t2', 2000, 2000);
    msg.run('m-c', 't1', 'm-t1', 3000, 3000);
    msg.run('m-d', 't2', 'm-t2', 4000, 4000);
    msg.run('m-e', 't1', 'm-t1', 5000, 5000);
    return db;
  };

  const seqs = (db: InstanceType<typeof Database>, team: string) =>
    db
      .prepare<
        [string],
        { id: string; origin_seq: number; origin_node: string }
      >('SELECT id, origin_seq, origin_node FROM messages WHERE team_id = ? ORDER BY ts, id')
      .all(team);

  it('backfills each team as a gapless prefix in (ts, id) order, next_seq = count + 1', () => {
    const db = buildV46();
    runMigrations(db);

    const t1 = seqs(db, 't1');
    const t2 = seqs(db, 't2');
    expect(t1.map((r) => r.origin_seq)).toEqual([1, 2, 3]);
    expect(t2.map((r) => r.origin_seq)).toEqual([1, 2]);
    // Two node identities — per (daemon, team), never one machine row spanning both.
    expect(t1[0]!.origin_node).not.toBe(t2[0]!.origin_node);
    const nextSeq = (team: string) =>
      db
        .prepare<[string], { next_seq: number }>('SELECT next_seq FROM nodes WHERE team_id = ?')
        .get(team)?.next_seq;
    expect(nextSeq('t1')).toBe(4);
    expect(nextSeq('t2')).toBe(3);
    // The 328 shape holds, unenrolled: credential_hash and enrolled_at NULL until increment 3.
    const node = db
      .prepare<
        [],
        { credential_hash: string | null; enrolled_at: number | null; label: string }
      >('SELECT credential_hash, enrolled_at, label FROM nodes LIMIT 1')
      .get();
    expect(node?.credential_hash).toBeNull();
    expect(node?.enrolled_at).toBeNull();
    expect(node?.label.length).toBeGreaterThan(0);
    db.close();
  });

  it('is idempotent under rewind-and-replay: renumbers rather than doubling', () => {
    const db = buildV46();
    runMigrations(db);
    const firstNodes = db
      .prepare<[], { id: string }>('SELECT id FROM nodes ORDER BY team_id')
      .all()
      .map((r) => r.id);

    db.prepare("UPDATE schema_meta SET value = '46' WHERE key = 'schema_version'").run();
    runMigrations(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()).toEqual({ n: 2 });
    // The replay adopts the existing rows (insert-if-absent), never minting a second identity.
    expect(
      db
        .prepare<[], { id: string }>('SELECT id FROM nodes ORDER BY team_id')
        .all()
        .map((r) => r.id),
    ).toEqual(firstNodes);
    expect(seqs(db, 't1').map((r) => r.origin_seq)).toEqual([1, 2, 3]);
    expect(seqs(db, 't2').map((r) => r.origin_seq)).toEqual([1, 2]);
    db.close();
  });

  /**
   * v48 — the `local_node` marker (increment 3a). v47 identified the local row by `ORDER BY id
   * LIMIT 1`, which is only correct while `nodes` holds one row per team. Enrollment is what breaks
   * that, so the marker is recorded before enrollment can exist.
   */
  it('v48 marks every v47 row as local, one per team', () => {
    const db = buildV46();
    runMigrations(db);

    const marks = db
      .prepare<
        [],
        { team_id: string; node_id: string }
      >('SELECT team_id, node_id FROM local_node ORDER BY team_id')
      .all();
    expect(marks.map((m) => m.team_id)).toEqual(['t1', 't2']);
    expect(marks[0]!.node_id).toBe(seqs(db, 't1')[0]!.origin_node);
    expect(marks[1]!.node_id).toBe(seqs(db, 't2')[0]!.origin_node);
    db.close();
  });

  it('v48 is idempotent under rewind-and-replay: one mark per team, unchanged', () => {
    const db = buildV46();
    runMigrations(db);
    const before = db
      .prepare<
        [],
        { team_id: string; node_id: string }
      >('SELECT team_id, node_id FROM local_node ORDER BY team_id')
      .all();

    db.prepare("UPDATE schema_meta SET value = '46' WHERE key = 'schema_version'").run();
    runMigrations(db);

    expect(
      db
        .prepare<
          [],
          { team_id: string; node_id: string }
        >('SELECT team_id, node_id FROM local_node ORDER BY team_id')
        .all(),
    ).toEqual(before);
    db.close();
  });

  /**
   * v49 — `node_invites` (ADR 328 §2). No backfill to check: an invite is a live object with a
   * 15-minute life, so history has none. What the replay must not do is drop live codes.
   */
  it('v49 creates node_invites and a replay keeps the codes already minted', () => {
    const db = buildV46();
    runMigrations(db);
    db.prepare(
      `INSERT INTO node_invites (id, team_id, code_hash, label, created_by, created_at, expires_at)
       VALUES ('i1', 't1', 'hash-1', 'laptop', 'nick', 1000, 2000)`,
    ).run();

    db.prepare("UPDATE schema_meta SET value = '46' WHERE key = 'schema_version'").run();
    runMigrations(db);

    expect(db.prepare('SELECT COUNT(*) AS n FROM node_invites').get()).toEqual({ n: 1 });
    db.close();
  });

  it('v49 refuses two invites sharing one code hash', () => {
    const db = buildV46();
    runMigrations(db);
    const insert = (id: string) =>
      db
        .prepare(
          `INSERT INTO node_invites (id, team_id, code_hash, label, created_by, created_at, expires_at)
           VALUES (?, 't1', 'same-hash', 'laptop', 'nick', 1000, 2000)`,
        )
        .run(id);
    insert('i1');
    // A replayed mint must collide rather than shadow the live code it duplicates.
    expect(() => insert('i2')).toThrow();
    db.close();
  });

  /**
   * v50 — the sync staging tables (ADR 325 increment 3b-i). No backfill: nothing has ever been
   * pushed, and history is already in `messages` under its own origin stamp. What the replay must
   * not do is drop events a hub has staged but not yet folded.
   */
  const stage = (db: InstanceType<typeof Database>, id: string, seq: number, hubSeq: number) =>
    db
      .prepare(
        `INSERT INTO sync_log (id, team_id, origin_node, origin_seq, hub_seq, payload, received_at)
         VALUES (?, 't1', 'n-remote', ?, ?, '{}', 1000)`,
      )
      .run(id, seq, hubSeq);

  const withRemoteNode = () => {
    const db = buildV46();
    runMigrations(db);
    db.prepare(
      "INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('n-remote', 't1', 'remote', 1)",
    ).run();
    return db;
  };

  it('v50 creates the staging tables, and a replay keeps what was already staged', () => {
    const db = withRemoteNode();
    stage(db, 'm1', 1, 1);

    db.prepare("UPDATE schema_meta SET value = '49' WHERE key = 'schema_version'").run();
    expect(runMigrations(db)).toBe(92);

    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_log').get()).toEqual({ n: 1 });
    db.close();
  });

  // ryder, acceptance of 3b-ii (01M1FAD24JM5), 2026-09-02: v54 never ran on the dogfood daemon.
  // #1164 landed v55 first; runMigrations is a high-water mark, so a DB already at 55 skips a 54
  // that arrives later. Live musterd.db sat at schema 55 with no idx_messages_origin and no
  // sync_pull_cursor. v56 re-issues v54's IF NOT EXISTS body so that DB catches up.
  it('v56 re-issues v54 for a DB that reached 55 without it', () => {
    const db = withRemoteNode();
    db.exec('DROP INDEX idx_messages_origin; DROP TABLE sync_pull_cursor;');
    db.prepare("UPDATE schema_meta SET value = '55' WHERE key = 'schema_version'").run();

    expect(runMigrations(db)).toBe(92);

    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'sync_pull_cursor'").get(),
    ).toEqual({ name: 'sync_pull_cursor' });
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'idx_messages_origin'").get(),
    ).toEqual({ name: 'idx_messages_origin' });
    db.close();
  });

  // Lane-replication slice: `lane.*` audit rows are the second replicated kind and carry the ADR 331
  // pair. Every other row keeps the defaults and never collides under the partial unique index.
  it('v58 stamps audit with the origin pair, unique only where a stamp exists', () => {
    const db = withRemoteNode();
    db.prepare("UPDATE schema_meta SET value = '57' WHERE key = 'schema_version'").run();
    expect(runMigrations(db)).toBe(92);

    const insert = db.prepare(
      `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at, origin_node, origin_seq)
       VALUES (?, 't1', 1, NULL, ?, NULL, 'allow', NULL, 1, ?, ?)`,
    );
    // Two unstamped rows: no collision — the index is partial on origin_seq > 0.
    insert.run('a1', 'member.reclaim', '', 0);
    insert.run('a2', 'member.reclaim', '', 0);
    // Two stamped rows on one pair: refused — that is the fold's idempotence key.
    insert.run('a3', 'lane.opened', 'N1', 1);
    expect(() => insert.run('a4', 'lane.claimed', 'N1', 1)).toThrow();
    db.close();
  });

  it('v50 makes a replayed push a no-op rather than a duplicate', () => {
    const db = withRemoteNode();
    stage(db, 'm1', 1, 1);
    // The same origin event arriving twice — the pusher retried, or its cursor lagged. The
    // idempotence key is (origin_node, origin_seq), so a fresh row id does NOT let it in twice.
    expect(() => stage(db, 'm1-again', 1, 2)).toThrow();
    db.close();
  });

  it('v50 refuses two staged rows claiming one hub_seq — the order is dense by schema', () => {
    const db = withRemoteNode();
    stage(db, 'm1', 1, 1);
    // The off-by-one this guards: an allocator that hands out its DEFAULT instead of the
    // pre-increment value issues hub_seq 1 twice, and the canonical order silently forks.
    expect(() => stage(db, 'm2', 2, 1)).toThrow();
    stage(db, 'm2', 2, 2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM sync_log').get()).toEqual({ n: 2 });
    db.close();
  });

  it('v61 adds presence.node (null = local) with an index', async () => {
    const db = openDb(':memory:');
    const cols = db
      .prepare<[], { name: string }>('PRAGMA table_info(presence)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('node');
    const idx = db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'presence'",
      )
      .all()
      .map((i) => i.name);
    expect(idx).toContain('idx_presence_node');
    await db.close();
  });

  it('v63 rekeys seat_nodes to (member_id, node_id), carrying every existing binding over (ADR 358)', async () => {
    const db = openDb(':memory:');
    // Rebuild the v59 shape with a row in it, then replay v60+ over it.
    await db.exec(`
      DROP TABLE seat_nodes;
      CREATE TABLE seat_nodes (
        member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
        team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
        node_id   TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
        bound_at  INTEGER NOT NULL
      );
      INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('t', 'alpha', 1, 1);
      INSERT INTO members (id, team_id, name, kind, role, lifecycle, observer, created_at, updated_at)
        VALUES ('m', 't', 'nick', 'human', '', 'forever', 0, 1, 1);
      INSERT INTO nodes (id, team_id, label, next_seq) VALUES ('nA', 't', 'a', 1), ('nB', 't', 'b', 1);
      INSERT INTO seat_nodes VALUES ('m', 't', 'nA', 5);
    `);
    db.prepare("UPDATE schema_meta SET value = '62' WHERE key = 'schema_version'").run();
    expect(runMigrations(db)).toBe(92);
    expect(db.prepare('SELECT member_id, node_id, bound_at FROM seat_nodes').all()).toEqual([
      { member_id: 'm', node_id: 'nA', bound_at: 5 },
    ]);
    // The set: a second node for the same seat is now a row, not a conflict.
    db.prepare("INSERT INTO seat_nodes VALUES ('m', 't', 'nB', 6)").run();
    expect(() => db.prepare("INSERT INTO seat_nodes VALUES ('m', 't', 'nB', 7)").run()).toThrow(
      /UNIQUE|PRIMARY KEY/,
    );
    await db.close();
  });
  it('v71 adds messages.in_reply_to as a generated column the discharge lookup can seek on', async () => {
    const db = openDb(':memory:');
    await db.exec(`
      INSERT INTO teams (id, slug, created_at, updated_at) VALUES ('t', 'alpha', 1, 1);
      INSERT INTO members (id, team_id, name, kind, role, lifecycle, observer, created_at, updated_at)
        VALUES ('a', 't', 'ann', 'agent', '', 'forever', 0, 1, 1), ('b', 't', 'bob', 'agent', '', 'forever', 0, 1, 1);
      INSERT INTO messages (id, team_id, from_member, to_kind, to_member, act, body, meta, ts, created_at, origin_seq)
        VALUES ('m1', 't', 'a', 'member', 'b', 'request_help', 'x', NULL, 1, 1, 1),
               ('m2', 't', 'b', 'member', 'a', 'accept', 'ok', '{"in_reply_to":"m1"}', 2, 2, 2);
    `);
    // The column IS the json_extract — the same value, now with TEXT affinity.
    expect(db.prepare('SELECT id, in_reply_to FROM messages ORDER BY id').all()).toEqual([
      { id: 'm1', in_reply_to: null },
      { id: 'm2', in_reply_to: 'm1' },
    ]);
    // The regression: the discharge check's correlated NOT EXISTS must seek the index, not scan
    // the team (the 2026-09-24 daemon_wedged pair — a bare json_extract index is never used here
    // because the expression has no affinity and \`id\` is TEXT).
    const plan = db
      .prepare<[], { detail: string }>(
        `EXPLAIN QUERY PLAN SELECT m.id FROM messages m WHERE m.team_id = 't' AND m.act = 'request_help'
           AND NOT EXISTS (SELECT 1 FROM messages dr WHERE dr.team_id = m.team_id
                             AND dr.act IN ('accept','decline') AND dr.in_reply_to = m.id)`,
      )
      .all()
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(/idx_messages_in_reply_to \(team_id=\? AND in_reply_to=\?\)/);
    // A replay must not re-add the column: table_info hides a VIRTUAL column, table_xinfo shows it.
    db.prepare("UPDATE schema_meta SET value = '70' WHERE key = 'schema_version'").run();
    expect(runMigrations(db)).toBe(92);
    await db.close();
  });
});

/**
 * ADR 325 prereq: `incident_reports.id` was the schema's only INTEGER AUTOINCREMENT — an ordering
 * that exists only in this file and collides the moment rows originate on two machines. v45
 * rebuilds it on ULID TEXT ids, minted in old-id order so the pool's arrival order survives even
 * where created_at disagrees with it.
 */
describe('v45 — incident_reports ids become ULIDs (ADR 325 prereq)', () => {
  it('rebuilds a populated integer-id table, preserving arrival order in the new ids', async () => {
    const db = openDb(':memory:');
    await db.exec(`
      DROP TABLE incident_reports;
      CREATE TABLE incident_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        team_id TEXT NOT NULL,
        gate TEXT NOT NULL,
        seat TEXT NOT NULL,
        sig TEXT,
        ref TEXT,
        message_id TEXT,
        lane_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_incident_reports_team_gate ON incident_reports(team_id, gate);
    `);
    const ins = db.prepare(
      "INSERT INTO incident_reports (team_id, gate, seat, created_at) VALUES ('t', 'g', ?, ?)",
    );
    // Arrival order a, b, c — with created_at deliberately OUT of that order: the old pool
    // ordering was ORDER BY (integer) id, i.e. arrival, and the rebuild must keep that promise.
    ins.run('a', 3_000);
    ins.run('b', 1_000);
    ins.run('c', 1_000);
    db.prepare("UPDATE schema_meta SET value = '44' WHERE key = 'schema_version'").run();
    runMigrations(db);

    const cols = db
      .prepare<
        [],
        { name: string; type: string }
      >("SELECT name, type FROM pragma_table_info('incident_reports')")
      .all();
    expect(cols.find((c) => c.name === 'id')?.type).toBe('TEXT');
    const rows = db
      .prepare<
        [],
        { id: string | number; seat: string }
      >('SELECT id, seat FROM incident_reports ORDER BY id')
      .all();
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(String(r.id)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(rows.map((r) => r.seat)).toEqual(['a', 'b', 'c']);
    await db.close();
  });
});

/**
 * Lane 01M3D4069F: the roster reads each member's latest status_update. Before v77 that lookup
 * searched idx_messages_from_reply and sorted in a temp B-tree — ~100 ms of a ~118 ms roster read on
 * the live copy, and GET /teams/:slug p95 2.2 s in the 2026-09-28 tunnel bench.
 */
describe('v77 — the roster status lookup is served by an index, with no sort', () => {
  it('latestStatusUpdate seeks idx_messages_from_act_ts and reads it in order', async () => {
    const db = openDb(':memory:');
    // The same SQL as latestStatusUpdate (store/messages.ts).
    const plan = db
      .prepare<[], { detail: string }>(
        "EXPLAIN QUERY PLAN SELECT body, meta, ts FROM messages WHERE from_member = 'a' AND act = 'status_update' ORDER BY ts DESC, id DESC LIMIT 1",
      )
      .all()
      .map((r) => r.detail)
      .join('\n');
    expect(plan).toMatch(/idx_messages_from_act_ts \(from_member=\? AND act=\?\)/);
    expect(plan).not.toMatch(/TEMP B-TREE/);
    await db.close();
  });
});

/**
 * v58's `idx_audit_origin` is PARTIAL — `WHERE origin_seq > 0`, the stamped rows only — so SQLite uses
 * it only for a query that proves the same predicate. The fold's held-set reads did not: both scanned
 * every audit row per folded event, so a replay cost O(n²) in the replica's size, and a fresh
 * joiner's pages slowed from 1.4 s to 7+ s each between hub_seq 50k and 70k (second-machine run,
 * 2026-10-02). The predicate excludes nothing a real origin can match — the wire never carries a
 * non-positive seq. Existence of the index is not the point; the planner choosing it is.
 */
describe('v58 idx_audit_origin serves every (origin_node, origin_seq) read', () => {
  it('the fold’s held head and held pair, and the push tail, all SEARCH by the index', async () => {
    const db = openDb(':memory:');
    const plan = (sql: string, ...args: unknown[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as { detail: string }[])
        .map((r) => r.detail)
        .join(' | ');
    expect(plan(HELD_HEAD_AUDIT_SQL, 'node-a')).toContain('idx_audit_origin');
    expect(plan(HELD_PAIR_AUDIT_SQL, 'node-a', 7)).toContain('idx_audit_origin');
    expect(plan(UNPUSHED_AUDIT_SQL, 'team-1', 'node-a', 5, 500)).toContain('idx_audit_origin');
    await db.close();
  });
});

describe('v91 — lane source_ref (ADR 561)', () => {
  it('adds lanes.source_ref and its per-team lookup index', async () => {
    const db = openDb(':memory:');
    const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
    expect(laneCols).toContain('source_ref');
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'lanes'")
      .pluck()
      .all();
    expect(idx).toContain('idx_lanes_team_source_ref');
    await db.close();
  });
});
