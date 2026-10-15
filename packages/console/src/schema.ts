import { schemaVersion, type Queryable } from './db.js';

/**
 * The console's schema (ADR 615). Accounts are WHO a person is; membership stays on each team
 * server (spec §4.2), so there is no team, member or role table here and never will be — the one
 * join key a team server holds is `account_id`.
 *
 * - `accounts.id` is an opaque string, never an email: a team's member row binds it (§4.2), and
 *   emails change.
 * - `identities` is one row per (provider, subject) — GitHub, Google, an email magic link — so one
 *   account can hold several, and the binding is the provider's stable subject, never an email
 *   match (no auto-linking by email; big-body, 2026-10-15).
 * - `audit` is append-only for the runtime role: INSERT, nothing else (see GRANTS).
 */
export const SCHEMA_VERSION = 1;

export const MIGRATIONS: { version: number; sql: string }[] = [
  {
    version: 1,
    sql: `
CREATE TABLE IF NOT EXISTS console_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  created_at BIGINT NOT NULL,
  disabled_at BIGINT
);
CREATE TABLE IF NOT EXISTS identities (
  provider TEXT NOT NULL,
  subject TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  email TEXT,
  created_at BIGINT NOT NULL,
  last_used_at BIGINT,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS idx_identities_account ON identities(account_id);
CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  ts BIGINT NOT NULL,
  request_id TEXT,
  actor_account_id TEXT,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit(ts);`,
  },
];

/**
 * What the runtime role may do, granted by the owner after the ladder (big-body, 2026-10-15):
 * DML on accounts and identities; INSERT on audit and nothing else on it (no UPDATE, DELETE,
 * TRUNCATE); SELECT on the version row. No CREATE on the schema, no ownership, and no membership
 * in the owner role — a compromised runtime cannot rewrite the record, only add to it.
 * Retention on audit is a separate, audited maintenance role, not this one.
 */
export function grantsFor(runtimeRole: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(runtimeRole))
    throw new Error('the runtime role must be a plain lowercase identifier');
  return `
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${runtimeRole};
REVOKE CREATE ON SCHEMA public FROM ${runtimeRole};
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ${runtimeRole};
GRANT SELECT ON console_meta TO ${runtimeRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON accounts, identities TO ${runtimeRole};
GRANT INSERT ON audit TO ${runtimeRole};`;
}

/**
 * Bring the database to SCHEMA_VERSION as the owner, then (re)apply the runtime grants. `owner`
 * must be ONE connection (a `pg.Client`, not a Pool): the ladder runs between BEGIN and COMMIT.
 */
export async function migrate(owner: Queryable, runtimeRole: string): Promise<number> {
  const have = await schemaVersion(owner);
  if (have > SCHEMA_VERSION)
    throw new Error(
      `schema newer than this build: database is at schema ${have}, this build knows ${SCHEMA_VERSION}`,
    );
  for (const m of MIGRATIONS) {
    if (m.version <= have) continue;
    await owner.query('BEGIN');
    try {
      await owner.query(m.sql);
      await owner.query(
        `INSERT INTO console_meta (key, value) VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(m.version)],
      );
      await owner.query('COMMIT');
    } catch (err) {
      await owner.query('ROLLBACK');
      throw err;
    }
  }
  await owner.query(grantsFor(runtimeRole));
  return SCHEMA_VERSION;
}
