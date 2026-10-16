import type Database from 'better-sqlite3';
import type { Driver } from './driver.js';

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
];

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
): { version: number; up: (db: Database.Database) => void }[] {
  return ladder.map((m) => ({
    version: m.version,
    up: (db) => {
      if (m.sql !== undefined) db.exec(m.sql);
      else m.sqlite!(db);
    },
  }));
}
