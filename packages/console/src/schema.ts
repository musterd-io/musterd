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
 * - v2 (ADR 620): `sessions`, `auth_transactions` (OAuth and magic-link, single-use) and
 *   `rate_limits`. Sessions and transactions are never deleted by the runtime — revocation and
 *   consumption are columns, so the record survives; pruning is the maintenance role's.
 */
export const SCHEMA_VERSION = 2;

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
  {
    // v2 — sign-in state (ADR 620). Every secret is stored as a SHA-256 hash: a session id, a
    // transaction cookie, an OAuth state, a magic-link token. The PKCE verifier and nonce are kept
    // as issued (they are server-held and never leave the console). `session_generation` on the
    // account is what revoke-all bumps; a session whose generation is behind is dead.
    version: 2,
    sql: `
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS session_generation INTEGER NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  generation INTEGER NOT NULL,
  created_at BIGINT NOT NULL,
  last_activity_at BIGINT NOT NULL,
  idle_expires_at BIGINT NOT NULL,
  absolute_expires_at BIGINT NOT NULL,
  authenticated_at BIGINT NOT NULL,
  method TEXT NOT NULL,
  identity_provider TEXT NOT NULL,
  identity_subject TEXT NOT NULL,
  revoked_at BIGINT,
  revoke_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id);
CREATE TABLE IF NOT EXISTS auth_transactions (
  id_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  provider TEXT NOT NULL,
  state_hash TEXT,
  pkce_verifier TEXT,
  nonce TEXT,
  redirect_uri TEXT,
  return_path TEXT NOT NULL,
  email TEXT,
  token_hash TEXT,
  created_at BIGINT NOT NULL,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_auth_tx_token ON auth_transactions(token_hash) WHERE token_hash IS NOT NULL;
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket TEXT NOT NULL,
  window_start BIGINT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (bucket, window_start)
);`,
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
GRANT INSERT ON audit TO ${runtimeRole};
GRANT SELECT, INSERT, UPDATE ON sessions, auth_transactions TO ${runtimeRole};
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_limits TO ${runtimeRole};`;
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
