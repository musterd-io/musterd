import type Database from 'better-sqlite3';
import { redactPolicySecrets } from '../store/policyRedaction.js';
import type { Driver } from './driver.js';

function redactPolicyJson(json: string): string {
  return JSON.stringify(redactPolicySecrets(JSON.parse(json) as unknown));
}

function redactPolicyEventJson(json: string): string | null {
  const value = JSON.parse(json) as unknown;
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new TypeError('sync_log policy event must be an object');
  const payload = value as Record<string, unknown>;
  const event = payload['event'];
  if (typeof event !== 'object' || event === null || Array.isArray(event))
    throw new TypeError('sync_log event must be an object');
  const eventRecord = event as Record<string, unknown>;
  if (eventRecord['action'] !== 'policy.change') return null;
  return JSON.stringify({
    ...payload,
    event: { ...eventRecord, detail: redactPolicySecrets(eventRecord['detail']) },
  });
}

function scrubPolicyAuditSqlite(db: Database.Database): void {
  const auditRows = db
    .prepare("SELECT id, detail FROM audit WHERE action = 'policy.change'")
    .all() as {
    id: string;
    detail: string | null;
  }[];
  const updateAudit = db.prepare('UPDATE audit SET detail = ? WHERE id = ?');
  for (const row of auditRows) {
    if (row.detail === null) throw new TypeError('policy.change audit detail is null');
    updateAudit.run(redactPolicyJson(row.detail), row.id);
  }
  const syncRows = db
    .prepare(
      "SELECT id, payload FROM sync_log WHERE json_extract(payload, '$.event.action') = 'policy.change'",
    )
    .all() as { id: string; payload: string }[];
  const updateSync = db.prepare('UPDATE sync_log SET payload = ? WHERE id = ?');
  for (const row of syncRows) {
    const payload = redactPolicyEventJson(row.payload);
    if (payload !== null) updateSync.run(payload, row.id);
  }
}

async function scrubPolicyAuditPostgres(d: Driver): Promise<void> {
  const auditRows = await d.all<{ id: string; detail: string | null }>(
    "SELECT id, detail FROM audit WHERE action = 'policy.change'",
  );
  for (const row of auditRows) {
    if (row.detail === null) throw new TypeError('policy.change audit detail is null');
    await d.run('UPDATE audit SET detail = ? WHERE id = ?', [redactPolicyJson(row.detail), row.id]);
  }
  const syncRows = await d.all<{ id: string; payload: string }>(
    "SELECT id, payload FROM sync_log WHERE payload::jsonb #>> '{event,action}' = 'policy.change'",
  );
  for (const row of syncRows) {
    const payload = redactPolicyEventJson(row.payload);
    if (payload !== null)
      await d.run('UPDATE sync_log SET payload = ? WHERE id = ?', [payload, row.id]);
  }
}

/**
 * Spec §12.2: from v81 on there is ONE migration ladder for both engines. An entry is portable SQL
 * text (`sql`) that both engines accept as written, or — when the engines genuinely differ (SQLite
 * cannot `ALTER COLUMN`, Postgres has no `PRAGMA`) — an explicit pair of per-engine functions.
 * Exactly one of the two shapes; `ladder.test.ts` pins it. SQLite consumes the ladder through
 * `migrations.ts` (appended after the legacy 1–80 entries); Postgres through `pg/migrate.ts`
 * (after the frozen v80 baseline). `pnpm migrations:check` parses this file too.
 */
export interface PortableMigration {
  version: number;
  sql?: string;
  sqlite?: (db: Database.Database) => void;
  postgres?: (d: Driver) => Promise<void>;
  /**
   * SQLite only. Threaded onto the legacy `Migration.fkOff`: a table rebuild of an FK parent
   * (presence, since session_leases) must drop with enforcement off or the drop cascades. Postgres
   * never rebuilds that way, so it ignores this flag.
   */
  fkOff?: boolean;
}

/**
 * v83: the four tables that were owned only THROUGH `members` / `seeds`. Row-level security wants
 * one policy shape (`team_id = current_setting(...)`) on every team-owned table, so each gets the
 * column, backfilled from its owner and then required; orphans of a removed owner join nothing and
 * are dropped.
 */
const V83_TABLES = [
  ['presence', 'SELECT team_id FROM members m WHERE m.id = presence.member_id'],
  ['inbox_cursors', 'SELECT team_id FROM members m WHERE m.id = inbox_cursors.member_id'],
  ['seat_memory', 'SELECT team_id FROM members m WHERE m.id = seat_memory.member_id'],
  ['seed_thread_entries', 'SELECT team_id FROM seeds s WHERE s.id = seed_thread_entries.seed_id'],
] as const;

/** Live presence columns, in table order, at the moment v104 runs. Keep the CREATE in step. */
const PRESENCE_COLUMNS = [
  'id',
  'member_id',
  'surface',
  'status',
  'conn_id',
  'last_seen_at',
  'created_at',
  'held_until',
  'provenance',
  'workspace',
  'driver',
  'model',
  'build',
  'epoch',
  'wake_lease',
  'model_source',
  'node',
  'guidance_epoch',
  'team_id',
  'style_epoch',
] as const;

/** The presence CHECK list. `fold.ts` `STORABLE_SURFACES` must name the same set. */
const PRESENCE_SURFACES_SQL =
  "'cli','claude-code','codex','opencode','grok','cursor','web','ios','slack','other','musterd','muse'";

export const LADDER: PortableMigration[] = [
  {
    // v81 — ADR 487 (nothing vanishes, #1897): what a closing lane said is left (`follows_up_json`:
    // the JSON of `"none"` or a lane-id list; null reads as none) and why a lane was dropped
    // (`abandon_reason`). Nullable, no backfill. Landed as a SQLite-only entry and moved here so
    // Postgres runs it too (1B); the SQLite half is that entry verbatim.
    version: 81,
    sqlite: (db) => {
      const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!laneCols.includes('follows_up_json'))
        db.exec('ALTER TABLE lanes ADD COLUMN follows_up_json TEXT');
      if (!laneCols.includes('abandon_reason'))
        db.exec('ALTER TABLE lanes ADD COLUMN abandon_reason TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS follows_up_json TEXT');
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS abandon_reason TEXT');
    },
  },
  {
    // v82 — ADR 487 §5.2 (#1905): the seat session's unfinished to-do snapshot on its lane
    // (`unfinished_todos_json`: `{items, at}`, last write wins; null reads as none). Moved here
    // from migrations.ts as v81 was.
    version: 82,
    sqlite: (db) => {
      const laneCols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!laneCols.includes('unfinished_todos_json'))
        db.exec('ALTER TABLE lanes ADD COLUMN unfinished_todos_json TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS unfinished_todos_json TEXT');
    },
  },
  {
    version: 83,
    // Idempotent under rewind-and-replay (db.test.ts runs the ladder twice): the column is added
    // only when absent, and the backfill/prune re-run harmlessly.
    sqlite: (db) => {
      for (const [t, join] of V83_TABLES) {
        const cols = (db.prepare(`PRAGMA table_info(${t})`).all() as { name: string }[]).map(
          (c) => c.name,
        );
        if (!cols.includes('team_id')) db.exec(`ALTER TABLE ${t} ADD COLUMN team_id TEXT`);
        db.exec(`UPDATE ${t} SET team_id = (${join})`);
        db.exec(`DELETE FROM ${t} WHERE team_id IS NULL`);
        db.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_team ON ${t}(team_id)`);
      }
      // SQLite cannot add NOT NULL to an existing column; the store's inserts always set it, and
      // Postgres (below) enforces it. Documented in 01-data-model.md.
    },
    postgres: async (d) => {
      for (const [t, join] of V83_TABLES) {
        await d.exec(`ALTER TABLE ${t} ADD COLUMN IF NOT EXISTS team_id TEXT`);
        await d.exec(`UPDATE ${t} SET team_id = (${join})`);
        await d.exec(`DELETE FROM ${t} WHERE team_id IS NULL`);
        await d.exec(`ALTER TABLE ${t} ALTER COLUMN team_id SET NOT NULL`);
        await d.exec(`CREATE INDEX IF NOT EXISTS idx_${t}_team ON ${t}(team_id)`);
      }
    },
  },
  {
    // v84 — cloud 1C (spec §4.3): a console token redeems ONCE across every server, so its `jti`
    // is a row, not a process cache. Global — no tenant owns a console token (pg/tenancy.ts).
    // `exp` is the token's NumericDate (seconds); expired rows are pruned on redemption.
    version: 84,
    sql: 'CREATE TABLE IF NOT EXISTS console_token_jti (jti TEXT PRIMARY KEY, exp BIGINT NOT NULL)',
  },
  {
    // v85 — ADR 501 (halt as revocation): a human's operational hold on an agent seat. A standing,
    // not an `account_status`: `halted_at` set ⇒ halted; who and why ride beside it; resume clears
    // all three. Nullable, no backfill. Portable: both engines take ADD COLUMN IF NOT EXISTS.
    version: 85,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
      if (!cols.includes('halted_at')) db.exec('ALTER TABLE members ADD COLUMN halted_at INTEGER');
      if (!cols.includes('halted_by')) db.exec('ALTER TABLE members ADD COLUMN halted_by TEXT');
      if (!cols.includes('halted_reason'))
        db.exec('ALTER TABLE members ADD COLUMN halted_reason TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE members ADD COLUMN IF NOT EXISTS halted_at BIGINT');
      await d.exec('ALTER TABLE members ADD COLUMN IF NOT EXISTS halted_by TEXT');
      await d.exec('ALTER TABLE members ADD COLUMN IF NOT EXISTS halted_reason TEXT');
    },
  },
  {
    // v86 — ADR 514 (agent style): a human's own style dials and prose (`members.style_prefs`,
    // `StylePrefs` JSON; agents never carry one) and the style epoch a seat attests on attach and
    // heartbeat (`presence.style_epoch`, 8 hex chars; null = never attested, never read as stale).
    // Nullable, no backfill. Portable: both engines take ADD COLUMN IF NOT EXISTS.
    version: 86,
    sqlite: (db) => {
      const m = db.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
      if (!m.includes('style_prefs')) db.exec('ALTER TABLE members ADD COLUMN style_prefs TEXT');
      const p = db.prepare("SELECT name FROM pragma_table_info('presence')").pluck().all();
      if (!p.includes('style_epoch')) db.exec('ALTER TABLE presence ADD COLUMN style_epoch TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE members ADD COLUMN IF NOT EXISTS style_prefs TEXT');
      await d.exec('ALTER TABLE presence ADD COLUMN IF NOT EXISTS style_epoch TEXT');
    },
  },
  {
    // v87 — ADR 516 (holds): a time-bounded Team rule only a human admin sets or lifts. Active is
    // derived (`lifted_at IS NULL AND now < expires_at`) — no status column, no timer. Rows are never
    // deleted: the history is every rule the Team was under. The id is the hub's ULID and crosses the
    // fold verbatim, so set/lift are idempotent on every node. (v86 is ADR 514's, PR #2095.)
    version: 87,
    sqlite: (db) => {
      db.exec(HOLDS_TABLE_SQL);
      db.exec(HOLDS_INDEX_SQL);
    },
    postgres: async (d) => {
      await d.exec(HOLDS_TABLE_SQL);
      await d.exec(HOLDS_INDEX_SQL);
    },
  },
  {
    // v88 — ADR 519 (calendar entries as team data): the Team's calendar, read and written by any
    // active Member. `start_time`/`end_time` because `end` is reserved in SQL; `pick` is 0/1 on both
    // engines. Deletes are real deletes, recorded in audit (`calendar.entry_deleted`), which is also
    // what a `?since` delta reads them back from — no tombstone column. The partial unique index is
    // the one-time import's idempotency key (§5); an entry made in musterd has no `source_ref`.
    version: 88,
    sqlite: (db) => {
      db.exec(CALENDAR_TABLE_SQL);
      for (const sql of CALENDAR_INDEX_SQL) db.exec(sql);
    },
    postgres: async (d) => {
      await d.exec(CALENDAR_TABLE_SQL);
      for (const sql of CALENDAR_INDEX_SQL) await d.exec(sql);
    },
  },
  {
    // v89 — lane 01M477RQGV (Cloud run 14): `messages` re-analyzes after ~1 % churn, not the
    // default 10 %. Under the tenant policy the roster's latest-status pick plans on `team_id`
    // statistics, and a team newer than the last ANALYZE is absent from them: the planner scans
    // every status_update of the team per member (32 ms, ~25k buffers a roster read) instead of a
    // per-member index (3.8 ms). Neon resets the counters autovacuum triggers on at every compute
    // restart, so the default threshold is rarely reached. SQLite has no autovacuum — a no-op there.
    version: 89,
    sqlite: () => {},
    postgres: async (d) => {
      await d.exec(
        'ALTER TABLE messages SET (autovacuum_analyze_scale_factor = 0.01, autovacuum_analyze_threshold = 500)',
      );
    },
  },
  {
    // v90 — ADR 531 (origin_seq stamped at commit): a message is inserted with `origin_seq = 0` and
    // numbered just before its transaction commits, so two unstamped rows of one node can coexist
    // inside a transaction. The origin index becomes partial on `origin_seq > 0`, the shape
    // `idx_audit_origin` has had since v58. Every committed replicated row is stamped, so it still
    // enforces exactly what the full index did. Its readers say `origin_seq > 0` so it applies.
    version: 90,
    sqlite: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_messages_origin');
      db.exec(MESSAGES_ORIGIN_INDEX_SQL);
    },
    postgres: async (d) => {
      await d.exec('DROP INDEX IF EXISTS idx_messages_origin');
      await d.exec(MESSAGES_ORIGIN_INDEX_SQL);
    },
  },
  {
    // v91 — ADR 561: the issue a lane came from. Nullable, no backfill; a lane imported before this
    // keeps its `Source:` detail line until a re-sync adopts it. The index serves the per-ref lookup
    // the store runs before a write and `GET /lanes?source_ref=`; it is not unique — uniqueness is
    // "among lanes not done or abandoned", which only the store transaction can say.
    version: 91,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('source_ref')) db.exec('ALTER TABLE lanes ADD COLUMN source_ref TEXT');
      db.exec(LANES_SOURCE_REF_INDEX_SQL);
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS source_ref TEXT');
      await d.exec(LANES_SOURCE_REF_INDEX_SQL);
    },
  },
  {
    // v92 — lane 01M4S0ZAG8: the wake poll's per-seat audit reads (`deferralSnoozeUntil`, the dream
    // night's leases and deferrals, `residency.woke` lookups) filter on `target` inside one action.
    // `idx_audit_team_action_ts` stops at the action, so each read walked every row of it — 8,432
    // `residency.wake_deferred` rows per seat on the revive hub — and one poll spent ~800 ms of a
    // ~950 ms transaction there. With `target` in the key the same poll is ~150 ms.
    version: 92,
    sql: 'CREATE INDEX IF NOT EXISTS idx_audit_team_action_target_ts ON audit(team_id, action, target, ts)',
  },
  {
    // v93 — lane 01M4S7GW7P: the open-directed ledger asks, per open act, for the earliest `resolve`
    // in its thread (`threadResolve`: team_id, act, thread_id, ORDER BY ts LIMIT 1). With only
    // `(team_id, act, thread_id)` indexed SQLite preferred the `(team_id, ts)` index to dodge the sort
    // and walked every message of the team for each call: 305 calls × 23k rows, ~8.5 s of a cold
    // `/report` on the Air. With `ts` in the key the same lookup is a seek.
    version: 93,
    sql: 'CREATE INDEX IF NOT EXISTS idx_messages_thread_act_ts ON messages(team_id, act, thread_id, ts)',
  },
  {
    // v94 — ADR 576 §3: at most one live wake lease per seat, held by the schema. The claim no longer
    // derives inside one transaction, and on Postgres one transaction never prevented two polls
    // inserting for the same seat. A store that already holds two `leased` rows for a member keeps
    // the newest (ULIDs sort by time) and expires the rest, or the index could not be built.
    version: 94,
    sqlite: (db) => {
      db.exec(WAKE_LEASES_DEDUPE_SQL);
      db.exec(WAKE_LEASES_ONE_LIVE_SQL);
    },
    postgres: async (d) => {
      await d.exec(WAKE_LEASES_DEDUPE_SQL);
      await d.exec(WAKE_LEASES_ONE_LIVE_SQL);
    },
  },
  {
    // v95 — ADR 585: the verification rail. One nullable JSON column beside `merged_json` holding the
    // claims a seat filed at submit and the acceptor's re-check at accept, each with its verdict and
    // checker. No backfill: a lane submitted before the rail has no claims, and absence reads as such.
    version: 95,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('claims_json')) db.exec('ALTER TABLE lanes ADD COLUMN claims_json TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS claims_json TEXT');
    },
  },
  {
    // v96 — ADR 586 §3: the skill a role names, projected from `roles/<name>.toml`'s `skill`. NULL
    // when the file names none, which reads as the role's own name. No backfill.
    version: 96,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('roles')").pluck().all();
      if (!cols.includes('skill')) db.exec('ALTER TABLE roles ADD COLUMN skill TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE roles ADD COLUMN IF NOT EXISTS skill TEXT');
    },
  },
  {
    // v97 — ADR 478 on Cloud (lane 01M3W6GWVN): where churn-class `audit` rows go before they are
    // pruned when there is no disk to archive beside. One row per (team, month, batch): `body` is the
    // base64 of a gzip of the rows as JSONL, the same bytes the local `audit-YYYY-MM.jsonl.gz` member
    // holds. Text, not BLOB/BYTEA, so both engines and every driver read it back as a string. Written
    // in the same transaction as the delete, so a failed archive prunes nothing. Team-owned (tenant
    // policy). A local SQLite store keeps archiving to its file; the table exists there, empty.
    version: 97,
    sql: `CREATE TABLE IF NOT EXISTS audit_archive (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  month TEXT NOT NULL,
  row_count INTEGER NOT NULL,
  from_ts BIGINT NOT NULL,
  to_ts BIGINT NOT NULL,
  body TEXT NOT NULL,
  created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_archive_team_month ON audit_archive(team_id, month)`,
  },
  {
    // v98 — ADR 582 §3 (lane 01M4VKSDJH): explicit area override on a lane (`areas_json`: JSON array
    // of area names; null means use the areas derived at read time from `surface_globs`).
    version: 98,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('areas_json')) db.exec('ALTER TABLE lanes ADD COLUMN areas_json TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS areas_json TEXT');
    },
  },
  {
    // v99 — ADR 621 (talk-only guests, lane 01M3Z42GN1): a member's ceiling (`'guest'` or NULL),
    // applied at read time so reconcile cannot widen it, and the ceiling an invite stamps on the
    // members it admits. Nullable, no backfill: NULL is "no ceiling" on a member and "admits members"
    // on an invite minted before 621.
    version: 99,
    sqlite: (db) => {
      const m = db.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
      if (!m.includes('ceiling')) db.exec('ALTER TABLE members ADD COLUMN ceiling TEXT');
      const i = db.prepare("SELECT name FROM pragma_table_info('team_invites')").pluck().all();
      if (!i.includes('ceiling')) db.exec('ALTER TABLE team_invites ADD COLUMN ceiling TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE members ADD COLUMN IF NOT EXISTS ceiling TEXT');
      await d.exec('ALTER TABLE team_invites ADD COLUMN IF NOT EXISTS ceiling TEXT');
    },
  },
  {
    // v100 — ADR 623 §5 (away channels 2c, lane 01M515KYT64): the ask token and the decision record.
    // `ask_channel_tokens` keeps only the sha256 of a token (hard rule 5). `ask_decisions` has ONE row
    // per ask across every channel: its primary key is the compare-and-set that makes a decision
    // atomic. New tables, no backfill; both are team-owned, so row-level security covers them.
    version: 100,
    sql: `CREATE TABLE IF NOT EXISTS ask_channel_tokens (
  token_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  ask_id TEXT NOT NULL,
  ask_digest TEXT NOT NULL,
  action_class TEXT NOT NULL,
  channel TEXT NOT NULL,
  binding_id TEXT NOT NULL,
  binding_generation INTEGER NOT NULL,
  required_assurance TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_ask_channel_tokens_team_ask ON ask_channel_tokens(team_id, ask_id);
CREATE TABLE IF NOT EXISTS ask_decisions (
  team_id TEXT NOT NULL REFERENCES teams(id),
  ask_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  message_id TEXT NOT NULL,
  decided_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, ask_id)
)`,
  },
  {
    // v101 — ADR 624 (lane picker, lane 01M5162MTC): a lane's latest decline (`declined_json`:
    // `{by, reason, at}` from a release that gave a reason; cleared by any claim). Nullable, no
    // backfill: NULL is "never declined".
    version: 101,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('declined_json'))
        db.exec('ALTER TABLE lanes ADD COLUMN declined_json TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS declined_json TEXT');
    },
  },
  {
    // v102 — ADR 629 (lane 01M4EDCQ2W): who asked for a lane. JSON `{by, basis, ref?}`. Null means
    // missing, which is not the opener and not "nobody". No backfill: lanes opened before this
    // stay missing, and the reply on a new open says how to fill the field.
    version: 102,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('requested_json'))
        db.exec('ALTER TABLE lanes ADD COLUMN requested_json TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS requested_json TEXT');
    },
  },
  {
    // v103 — ADR 640 (lane 01M55K7KA9): how a tool call arrived (`rail`: `stdio` or `remote`), part
    // of the aggregate's key so a seat's phone calls and desk calls land in separate rows. Every
    // existing row came from a stdio adapter, so the default is true of all of them. SQLite cannot
    // change a primary key in place, so it rebuilds the table; Postgres swaps the key.
    version: 103,
    sqlite: (db) => {
      const cols = db
        .prepare("SELECT name FROM pragma_table_info('tool_call_stats')")
        .pluck()
        .all();
      if (cols.includes('rail')) return;
      db.exec(`
        CREATE TABLE tool_call_stats_v103 (
          team_id           TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          seat              TEXT NOT NULL,
          role              TEXT,
          rail              TEXT NOT NULL DEFAULT 'stdio',
          tool              TEXT NOT NULL,
          outcome           TEXT NOT NULL,
          bucket_start      INTEGER NOT NULL,
          calls             INTEGER NOT NULL DEFAULT 0,
          total_duration_ms INTEGER NOT NULL DEFAULT 0,
          max_duration_ms   INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (team_id, seat, rail, tool, outcome, bucket_start)
        );
        INSERT INTO tool_call_stats_v103
          (team_id, seat, role, rail, tool, outcome, bucket_start, calls, total_duration_ms,
           max_duration_ms)
          SELECT team_id, seat, role, 'stdio', tool, outcome, bucket_start, calls,
                 total_duration_ms, max_duration_ms
          FROM tool_call_stats;
        DROP TABLE tool_call_stats;
        ALTER TABLE tool_call_stats_v103 RENAME TO tool_call_stats;
        CREATE INDEX idx_tool_call_stats_team_bucket ON tool_call_stats(team_id, bucket_start);
      `);
    },
    postgres: async (d) => {
      await d.exec(
        "ALTER TABLE tool_call_stats ADD COLUMN IF NOT EXISTS rail TEXT NOT NULL DEFAULT 'stdio'",
      );
      await d.exec('ALTER TABLE tool_call_stats DROP CONSTRAINT IF EXISTS tool_call_stats_pkey');
      await d.exec(
        'ALTER TABLE tool_call_stats ADD PRIMARY KEY (team_id, seat, rail, tool, outcome, bucket_start)',
      );
    },
  },
  {
    // v104 — ADR 619 storage half. SURFACES gained `muse` on 2026-10-15; the presence CHECK last
    // grew at v57 (`grok`). A muse join then failed in the claim handler with
    // `CHECK constraint failed: surface`. SQLite cannot ALTER a CHECK, so this is the v57
    // copy-drop-rename. The column list is the live table (v57 + node, guidance_epoch, team_id,
    // style_epoch); a drift from that list throws rather than dropping a column. `fkOff` because
    // session_leases references presence ON DELETE CASCADE — a drop with enforcement on would
    // delete every live lease. Postgres replaces the CHECK in place. v103 (ADR 640) already owns
    // the previous number; it does not touch presence.
    version: 104,
    fkOff: true,
    sqlite: (db) => {
      const names = (db.prepare('PRAGMA table_info(presence)').all() as { name: string }[]).map(
        (c) => c.name,
      );
      if (names.join(',') !== PRESENCE_COLUMNS.join(',')) {
        throw new Error(
          `v104 presence columns drifted from the enumerated copy: ${names.join(',')}`,
        );
      }
      const cols = PRESENCE_COLUMNS.join(', ');
      db.exec(`
        CREATE TABLE presence_new (
          id            TEXT PRIMARY KEY,
          member_id     TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          surface       TEXT NOT NULL CHECK (surface IN (${PRESENCE_SURFACES_SQL})),
          status        TEXT NOT NULL DEFAULT 'online' CHECK (status IN ('online','away','offline')),
          conn_id       TEXT,
          last_seen_at  INTEGER NOT NULL,
          created_at    INTEGER NOT NULL,
          held_until    INTEGER,
          provenance    TEXT,
          workspace     TEXT,
          driver        TEXT,
          model         TEXT,
          build         TEXT,
          epoch         INTEGER,
          wake_lease    TEXT,
          model_source  TEXT,
          node          TEXT,
          guidance_epoch INTEGER,
          team_id       TEXT,
          style_epoch   TEXT
        );
        INSERT INTO presence_new (${cols}) SELECT ${cols} FROM presence;
        DROP TABLE presence;
        ALTER TABLE presence_new RENAME TO presence;
        CREATE INDEX IF NOT EXISTS idx_presence_member ON presence(member_id);
        CREATE INDEX IF NOT EXISTS idx_presence_last_seen ON presence(last_seen_at);
        CREATE INDEX IF NOT EXISTS idx_presence_node ON presence(node);
        CREATE INDEX IF NOT EXISTS idx_presence_team ON presence(team_id);
      `);
    },
    postgres: async (d) => {
      const checks = await d.all<{ name: string }>(
        `SELECT c.conname AS name
           FROM pg_constraint c
           JOIN pg_class r ON r.oid = c.conrelid
          WHERE r.relname = 'presence'
            AND c.contype = 'c'
            AND pg_get_constraintdef(c.oid) ILIKE '%surface%'`,
      );
      for (const check of checks) {
        if (!/^[a-z_][a-z0-9_]*$/.test(check.name)) {
          throw new Error(`v104 refuses to drop constraint ${check.name}`);
        }
        await d.exec(`ALTER TABLE presence DROP CONSTRAINT ${check.name}`);
      }
      await d.exec(
        `ALTER TABLE presence ADD CONSTRAINT presence_surface_check CHECK (surface IN (${PRESENCE_SURFACES_SQL}))`,
      );
    },
  },
  {
    // v105 — ADR 644 (lane 01M55WJXNP): the day a lane's read is due (`reads_on`, `YYYY-MM-DD`) and
    // the verdict that answers it (`read_verdict_json`: `{outcome, note, by, at}`). Both nullable,
    // no backfill: a lane opened before this is undated. `read_status` is derived, never stored.
    version: 105,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('reads_on')) db.exec('ALTER TABLE lanes ADD COLUMN reads_on TEXT');
      if (!cols.includes('read_verdict_json'))
        db.exec('ALTER TABLE lanes ADD COLUMN read_verdict_json TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS reads_on TEXT');
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS read_verdict_json TEXT');
    },
  },
  {
    // v106 — ADR 645 (lane 01M55PDKAT): the pre-registered declaration (`pre_registered_json`:
    // `{run, verdict_rule, record, expected_spend, by, at}`, nullable, no backfill — nothing was
    // declared before this) and the band-2 announcement table. One announcement row per (lane,
    // seat) pull in flight; the hub transitions it atomically (announced → granted | declined →
    // claimed), so on Cloud, where N daemons share one database, the first server to take a window
    // owns it. Not replicated: the pull is decided at the hub and the claim it ends in is an
    // ordinary replicated lane edge.
    version: 106,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('pre_registered_json'))
        db.exec('ALTER TABLE lanes ADD COLUMN pre_registered_json TEXT');
      db.exec(`
        CREATE TABLE IF NOT EXISTS pull_announcements (
          id              TEXT PRIMARY KEY,
          team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          lane_id         TEXT NOT NULL,
          member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          host            TEXT NOT NULL,
          ask_id          TEXT NOT NULL,
          announced_by    TEXT NOT NULL,
          tier            TEXT NOT NULL CHECK (tier IN ('advisory', 'standard')),
          state           TEXT NOT NULL CHECK (state IN ('announced', 'granted', 'claimed', 'declined')),
          lane_updated_at INTEGER NOT NULL,
          announced_at    INTEGER NOT NULL,
          window_ends_at  INTEGER NOT NULL,
          decided_at      INTEGER,
          reason          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pull_announcements_team_state ON pull_announcements(team_id, state);
        CREATE INDEX IF NOT EXISTS idx_pull_announcements_lane ON pull_announcements(team_id, lane_id);
      `);
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS pre_registered_json TEXT');
      await d.exec(`
        CREATE TABLE IF NOT EXISTS pull_announcements (
          id              TEXT PRIMARY KEY,
          team_id         TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
          lane_id         TEXT NOT NULL,
          member_id       TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
          host            TEXT NOT NULL,
          ask_id          TEXT NOT NULL,
          announced_by    TEXT NOT NULL,
          tier            TEXT NOT NULL CHECK (tier IN ('advisory', 'standard')),
          state           TEXT NOT NULL CHECK (state IN ('announced', 'granted', 'claimed', 'declined')),
          lane_updated_at INTEGER NOT NULL,
          announced_at    INTEGER NOT NULL,
          window_ends_at  INTEGER NOT NULL,
          decided_at      INTEGER,
          reason          TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_pull_announcements_team_state ON pull_announcements(team_id, state);
        CREATE INDEX IF NOT EXISTS idx_pull_announcements_lane ON pull_announcements(team_id, lane_id);
      `);
    },
  },
  {
    // v107 — ADR 654 (lane 01M561Y8QF): who saved a seat's note — `writer`, a JSON stamp
    // `{surface?, workspace?, node?, machine?}` of the saving session, nullable, no backfill: a note
    // saved before this reads as "not recorded", never as suspect.
    version: 107,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('seat_memory')").pluck().all();
      if (!cols.includes('writer')) db.exec('ALTER TABLE seat_memory ADD COLUMN writer TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE seat_memory ADD COLUMN IF NOT EXISTS writer TEXT');
    },
  },
  {
    // v108 — lane 01M57Y2E7Z: v106 typed `pull_announcements`' epoch-ms columns INTEGER on
    // Postgres, which is 32-bit there, so the first announcement overflowed it ("out of range for
    // type integer"). SQLite's INTEGER is 64-bit and was never affected. Widen them in place.
    version: 108,
    sqlite: () => {},
    postgres: async (d) => {
      await d.exec(`ALTER TABLE pull_announcements
        ALTER COLUMN lane_updated_at TYPE BIGINT,
        ALTER COLUMN announced_at TYPE BIGINT,
        ALTER COLUMN window_ends_at TYPE BIGINT,
        ALTER COLUMN decided_at TYPE BIGINT`);
    },
  },
  {
    // v109 — ADR 657 (lane 01M561YWP0): a machine's public note key — the raw X25519 public half,
    // base64url — a human seat's note is sealed to. Nullable: a machine has one only once a human
    // seat on it has needed it.
    version: 109,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('nodes')").pluck().all();
      if (!cols.includes('note_key')) db.exec('ALTER TABLE nodes ADD COLUMN note_key TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE nodes ADD COLUMN IF NOT EXISTS note_key TEXT');
    },
  },
  {
    // v110 — ADR 618 §7 (away channels 4 pairing, lane 01M50XPYZ9877E494X2SV1EGTB): the binding
    // store and the pairing nonces. A binding links an immutable provider identity to a human
    // Member in the daemon; the relay can neither create nor complete one. Only the sha256 of a
    // pairing nonce is stored (hard rule 5); the two-digit check code is a UX check, never a
    // secret. New tables, no backfill; both are team-owned, so row-level security covers them.
    version: 110,
    sql: `CREATE TABLE IF NOT EXISTS channel_bindings (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  member_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  provider_tenant_id TEXT NOT NULL,
  provider_user_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_channel_bindings_team_member ON channel_bindings(team_id, member_id, status);
CREATE TABLE IF NOT EXISTS pairing_nonces (
  id TEXT PRIMARY KEY,
  nonce_hash TEXT NOT NULL UNIQUE,
  team_id TEXT NOT NULL REFERENCES teams(id),
  member_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  check_code TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_tenant_id TEXT,
  provider_user_id TEXT,
  attempts INTEGER NOT NULL,
  expires_at BIGINT NOT NULL,
  created_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE INDEX IF NOT EXISTS idx_pairing_nonces_team_member ON pairing_nonces(team_id, member_id, state)`,
  },
  {
    // v111 — channel settings (away channels 6, lane 01M50XQ5YXXPJ8KVCV31KFB2N8; spec: Channel
    // settings): one row per human per channel. No row = nothing on (nothing is on by default).
    // Team-owned; RLS covers it like the v110 tables.
    version: 111,
    sql: `CREATE TABLE IF NOT EXISTS member_channel_settings (
  team_id TEXT NOT NULL REFERENCES teams(id),
  member_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  deliver_enabled INTEGER NOT NULL,
  answer_enabled INTEGER NOT NULL,
  presence_gating INTEGER NOT NULL,
  tier_floor TEXT,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY (team_id, member_id, channel)
)`,
  },
  {
    // v112 — ADR 673 (lane 01M5B1YQVH): what a dated read measures (`lanes.metric_json`:
    // `{name, unit, baseline, target, direction, source, by, at}`, nullable, no backfill) and its
    // daily samples, one row per lane per day — a later write for the day replaces it. Team-owned.
    version: 112,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('lanes')").pluck().all();
      if (!cols.includes('metric_json')) db.exec('ALTER TABLE lanes ADD COLUMN metric_json TEXT');
      db.exec(LANE_SAMPLES_TABLE_SQL);
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE lanes ADD COLUMN IF NOT EXISTS metric_json TEXT');
      await d.exec(LANE_SAMPLES_TABLE_SQL);
    },
  },
  {
    // Human authority (ADR 662, lane 01M5ANFFVHY07ZTYEECTRSTXTN): device keys bound to a
    // human (public half only — the private key never leaves the authenticator), and the
    // one-use approval nonces the server mints with each descriptor. A nonce row is spent
    // exactly once, on a verified presentation or not at all.
    version: 113,
    sql: `CREATE TABLE IF NOT EXISTS device_keys (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  member_id TEXT NOT NULL,
  public_key TEXT NOT NULL,
  kind TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  revoked_at BIGINT
);
CREATE TABLE IF NOT EXISTS approval_nonces (
  nonce TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  member_id TEXT NOT NULL,
  descriptor_digest TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
)`,
  },
  {
    // Device-key lifecycle (ADR 662 decision 6, lane 01M5ANFKEVTENBNVG9JQKA965N): one-time
    // enrollment codes. Only the sha256 is stored; the code itself is shown once to the
    // human who asked for it and never audited (hard rule 5).
    version: 114,
    sql: `CREATE TABLE IF NOT EXISTS enrollment_codes (
  code_hash TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  member_id TEXT NOT NULL,
  expires_at BIGINT NOT NULL,
  used_at BIGINT
)`,
  },
  {
    // Authenticators (ADR 662 decision 5, lane 01M5ANFZEQJN69EEV9T8EHT66S): passkeys name
    // their credential, and a descriptor row remembers what it was built for so the
    // daemon's own approval page can render it from server data. A presented passkey proof
    // is parked on the nonce row for the waiting surface to collect; the act still verifies
    // it cryptographically at presentation, the parked copy is only transport.
    version: 115,
    sqlite: (db) => {
      const keyCols = db.prepare("SELECT name FROM pragma_table_info('device_keys')").pluck().all();
      if (!keyCols.includes('credential_id'))
        db.exec('ALTER TABLE device_keys ADD COLUMN credential_id TEXT');
      const nonceCols = db
        .prepare("SELECT name FROM pragma_table_info('approval_nonces')")
        .pluck()
        .all();
      for (const col of [
        'actor',
        'act',
        'target',
        'payload_digest',
        'proof_key_id',
        'proof_signature',
        'proof_authenticator_data',
        'proof_client_data_json',
      ]) {
        if (!nonceCols.includes(col)) db.exec(`ALTER TABLE approval_nonces ADD COLUMN ${col} TEXT`);
      }
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE device_keys ADD COLUMN IF NOT EXISTS credential_id TEXT');
      for (const col of [
        'actor',
        'act',
        'target',
        'payload_digest',
        'proof_key_id',
        'proof_signature',
        'proof_authenticator_data',
        'proof_client_data_json',
      ]) {
        await d.exec(`ALTER TABLE approval_nonces ADD COLUMN IF NOT EXISTS ${col} TEXT`);
      }
    },
  },
  {
    // The musterd app's channel (ADR 676 §5, lane 01M5BER5GX4WENE2CEST6CA8NB): an app pairing
    // stages the phone's public keys and App Attest verdict on its nonce row, and the binding it
    // becomes keeps them — the receive key deliveries are sealed to and the device key that signs
    // answers. Public halves only, as JSON.
    version: 117,
    sqlite: (db) => {
      for (const table of ['pairing_nonces', 'channel_bindings']) {
        const cols = db.prepare(`SELECT name FROM pragma_table_info('${table}')`).pluck().all();
        if (!cols.includes('app_keys')) db.exec(`ALTER TABLE ${table} ADD COLUMN app_keys TEXT`);
      }
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE pairing_nonces ADD COLUMN IF NOT EXISTS app_keys TEXT');
      await d.exec('ALTER TABLE channel_bindings ADD COLUMN IF NOT EXISTS app_keys TEXT');
    },
  },
  {
    // ADR 677: remove policy credentials from replicated audit history without changing event
    // identity, sequence, or ordinary policy fields. Malformed matching JSON aborts the migration.
    version: 118,
    sqlite: scrubPolicyAuditSqlite,
    postgres: scrubPolicyAuditPostgres,
  },
  {
    // The distributed Slack app (ADR 668 decisions 2/5, lane 01M50ZQGWYNZKNWDNDDRP41W5B):
    // one install record per workspace (its per-install bot token, replacing the team-policy
    // token) and the one-time install states a human minted here, stored only as sha256.
    // The token is a credential: it is never audited, logged, exported or shown (hard rule 5).
    version: 119,
    sql: `CREATE TABLE IF NOT EXISTS slack_installs (
  team_id TEXT NOT NULL REFERENCES teams(id),
  slack_team_id TEXT NOT NULL,
  bot_token TEXT NOT NULL,
  installer_slack_id TEXT NOT NULL,
  installed_at BIGINT NOT NULL,
  revoked_at BIGINT,
  PRIMARY KEY (team_id, slack_team_id)
);
CREATE TABLE IF NOT EXISTS slack_install_requests (
  team_id TEXT NOT NULL REFERENCES teams(id),
  state_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  consumed_at BIGINT,
  PRIMARY KEY (team_id, state_hash)
)`,
  },
  {
    // Away 10 decline fix: an install request may carry the Cloud destination its
    // hosted server registered at mint (`MUSTERD_PUBLIC_ORIGIN`, validated as an
    // https origin), so the relay never takes a destination from the install link.
    version: 120,
    sqlite: (db) => {
      const cols = db
        .prepare("SELECT name FROM pragma_table_info('slack_install_requests')")
        .pluck()
        .all();
      if (!cols.includes('destination'))
        db.exec('ALTER TABLE slack_install_requests ADD COLUMN destination TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE slack_install_requests ADD COLUMN IF NOT EXISTS destination TEXT');
    },
  },
  {
    // ADR 689: a sponsor-scoped credential projected from another node carries that node's id in
    // `replicated_from` (null = minted here). A replicated row is honoured sponsor-only — never
    // team-wide, whatever its creator is on the hub (decision 2). Nullable, no backfill.
    version: 121,
    sqlite: (db) => {
      const cols = db
        .prepare("SELECT name FROM pragma_table_info('agent_bootstrap_credentials')")
        .pluck()
        .all();
      if (!cols.includes('replicated_from'))
        db.exec('ALTER TABLE agent_bootstrap_credentials ADD COLUMN replicated_from TEXT');
    },
    postgres: async (d) => {
      await d.exec(
        'ALTER TABLE agent_bootstrap_credentials ADD COLUMN IF NOT EXISTS replicated_from TEXT',
      );
    },
  },
  {
    // ADR 689 decision 5: the node a host label is bound to — first-writer-wins at the hub's
    // ingest of a host-authored row (`bindHostToNode`); null until a row in its name is pushed.
    version: 122,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('host_liveness')").pluck().all();
      if (!cols.includes('node')) db.exec('ALTER TABLE host_liveness ADD COLUMN node TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE host_liveness ADD COLUMN IF NOT EXISTS node TEXT');
    },
  },
  {
    // ADR 697: what a hold's hand-over needs. `gate_hold_refusals` remembers that a seat was refused
    // a file another lane held, until its first edit after the hold ends; `lane_heads` keeps the last
    // HEAD an edit inside a lane reported. Daemon-local and not replicated: the gate that refused is
    // the gate that hands over. The path is kept here, never in the shapes-only audit row (ADR 150).
    version: 123,
    sqlite: (db) => {
      db.exec(GATE_HOLD_REFUSALS_TABLE_SQL);
      db.exec(LANE_HEADS_TABLE_SQL);
    },
    postgres: async (d) => {
      await d.exec(GATE_HOLD_REFUSALS_TABLE_SQL);
      await d.exec(LANE_HEADS_TABLE_SQL);
    },
  },
  {
    // v124 — lane 01M5G7KWJP: one lane's history (`laneHistory`: team_id, `action LIKE 'lane.%'`,
    // target, ORDER BY ts) had no index it could seek. The LIKE stops `idx_audit_team_action_*` at
    // the team, so every `GET /lanes/:id`, `lane show` and /live's ask recovery walked all of the
    // team's audit rows — 306,790 on the revive hub, 3.9 s cold, each one a synchronous stall of the
    // daemon's event loop. A lane id is a ULID, so `(team_id, target)` leaves a handful of rows.
    version: 124,
    sql: 'CREATE INDEX IF NOT EXISTS idx_audit_team_target_ts ON audit(team_id, target, ts)',
  },
  {
    // v125 — lane 01M5G9FKCG: every `GET /inbox` counts the reader's whole inbox (`countInbox`) and
    // its unread remainder (`countUnread`), and the interrupt check walks the same rows. Each filters
    // on to_kind / to_member / from_member, none of which `(team_id, created_at)` carries, so every
    // count fetched every message row since the floor — all 30k for a seat with no cursor. On the
    // revive hub's 491 MB file those rows do not stay cached: 93 ms idle, ~670 ms under load, a
    // synchronous event-loop stall each (183 s in 30 min). With the filter columns and `id` (the
    // cursor tiebreak) in the key the counts never touch the table: 3.4 MB of index for 28 MB of
    // rows, measured on a copy of the hub's messages.
    version: 125,
    sql: 'CREATE INDEX IF NOT EXISTS idx_messages_inbox_cover ON messages(team_id, created_at, id, to_kind, to_member, from_member)',
  },
  {
    // ADR 698 (spec §4.2): the console account a member is bound to, set write-once at the first
    // hosted sign-in by bindMemberAccount. Nullable, no backfill: unbound is the honest state for
    // every existing member, and the binding is written, never derived.
    version: 126,
    sqlite: (db) => {
      const cols = db.prepare("SELECT name FROM pragma_table_info('members')").pluck().all();
      if (!cols.includes('account_id')) db.exec('ALTER TABLE members ADD COLUMN account_id TEXT');
    },
    postgres: async (d) => {
      await d.exec('ALTER TABLE members ADD COLUMN IF NOT EXISTS account_id TEXT');
    },
  },
  {
    // ADR 698, ryder's #3138 review: one console account binds at most one live member per
    // team. The partial unique index is the race backstop under bindMemberAccount's atomic
    // write-once UPDATE; departed members (left_at set) still hold their row, so the index
    // covers every row — a rejoin is a new member row and must not steal the account either.
    version: 127,
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_members_team_account ON members(team_id, account_id) WHERE account_id IS NOT NULL',
  },
];

const GATE_HOLD_REFUSALS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS gate_hold_refusals (
  team_id TEXT NOT NULL REFERENCES teams(id),
  seat TEXT NOT NULL,
  path TEXT NOT NULL,
  holder TEXT NOT NULL,
  holder_lane_id TEXT NOT NULL,
  refused_at BIGINT NOT NULL,
  handed_over_at BIGINT,
  PRIMARY KEY (team_id, seat, path)
)`;

const LANE_HEADS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS lane_heads (
  team_id TEXT NOT NULL REFERENCES teams(id),
  lane_id TEXT NOT NULL,
  head TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (team_id, lane_id)
)`;

const LANE_SAMPLES_TABLE_SQL = `CREATE TABLE IF NOT EXISTS lane_samples (
  team_id TEXT NOT NULL REFERENCES teams(id),
  lane_id TEXT NOT NULL,
  day TEXT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  n INTEGER NOT NULL,
  by_name TEXT NOT NULL,
  at BIGINT NOT NULL,
  PRIMARY KEY (team_id, lane_id, day)
)`;

const WAKE_LEASES_DEDUPE_SQL = `UPDATE wake_leases SET status = 'expired'
  WHERE status = 'leased'
    AND id NOT IN (SELECT MAX(id) FROM wake_leases WHERE status = 'leased' GROUP BY member_id)`;

const WAKE_LEASES_ONE_LIVE_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_wake_leases_one_live ON wake_leases(member_id) WHERE status = 'leased'";

const LANES_SOURCE_REF_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_lanes_team_source_ref ON lanes(team_id, source_ref) WHERE source_ref IS NOT NULL';

const MESSAGES_ORIGIN_INDEX_SQL =
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_origin ON messages(origin_node, origin_seq) WHERE origin_seq > 0';

const CALENDAR_TABLE_SQL = `CREATE TABLE IF NOT EXISTS calendar_entries (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  title TEXT NOT NULL,
  date TEXT NOT NULL,
  start_time TEXT,
  end_time TEXT,
  tz TEXT NOT NULL,
  kind TEXT NOT NULL,
  status TEXT,
  place TEXT NOT NULL,
  url TEXT,
  note TEXT NOT NULL,
  pick INTEGER NOT NULL,
  source TEXT NOT NULL,
  source_ref TEXT,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
)`;
const CALENDAR_INDEX_SQL = [
  'CREATE INDEX IF NOT EXISTS idx_calendar_team_updated ON calendar_entries(team_id, updated_at)',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_calendar_team_source_ref ON calendar_entries(team_id, source_ref) WHERE source_ref IS NOT NULL',
];

const HOLDS_TABLE_SQL = `CREATE TABLE IF NOT EXISTS holds (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id),
  effect TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  lifted_at BIGINT,
  lifted_by TEXT
)`;
const HOLDS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_holds_team_expires ON holds(team_id, expires_at)';

/** The SQLite view of a ladder: what `migrations.ts` / `traceDb.ts` append after their legacy entries. */
export function sqliteLadder(
  ladder: PortableMigration[] = LADDER,
): { version: number; up: (db: Database.Database) => void; fkOff?: boolean }[] {
  return ladder.map((m) => ({
    version: m.version,
    ...(m.fkOff ? { fkOff: true as const } : {}),
    up: (db) => {
      if (m.sql !== undefined) db.exec(m.sql);
      else m.sqlite!(db);
    },
  }));
}
