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
];

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
