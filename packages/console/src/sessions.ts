import type { Queryable } from './db.js';
import { hashSecret, newSecret } from './secrets.js';

/**
 * Console sessions (ADR 620 decision 7). The cookie carries an opaque 256-bit id; the database
 * keeps only its hash. A session is alive while it is not revoked, its idle and absolute expiries
 * are in the future, its account is not disabled, and its generation matches the account's
 * (revoke-all bumps the account's generation). Every read re-checks all of that in one query, so
 * revocation and disable take effect on the next request on every server — there is no cache.
 *
 * Lifetimes are nick's 2026-10-15 decision against NIST SP 800-63B-4 (AAL1's 30-day ceiling) and
 * comparable products: 14 days idle, 30 days absolute, and a sign-in within the last 15 minutes
 * for anything sensitive. A fresh sign-in makes a session recent; it does not raise its assurance.
 */
export const IDLE_MS = 14 * 24 * 60 * 60 * 1000;
export const ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const FRESH_MS = 15 * 60 * 1000;
/** Last-activity is written at most this often, so a busy page does not write on every request. */
export const TOUCH_EVERY_MS = 60 * 1000;

export interface Session {
  idHash: string;
  accountId: string;
  createdAt: number;
  authenticatedAt: number;
  method: string;
  identityProvider: string;
  identitySubject: string;
  absoluteExpiresAt: number;
}

export interface NewSession {
  accountId: string;
  method: 'github' | 'google' | 'email';
  identityProvider: string;
  identitySubject: string;
}

/**
 * Issue a fresh session — always a new id, never an adopted one (session fixation). Returns the
 * cookie value, which exists only here and in the browser.
 */
export async function createSession(db: Queryable, s: NewSession, now: number): Promise<string> {
  const sid = newSecret();
  const gen = await db.query<{ g: number }>(
    'SELECT session_generation AS g FROM accounts WHERE id = $1 AND disabled_at IS NULL',
    [s.accountId],
  );
  const g = gen.rows[0];
  if (!g) throw new Error('account not found or disabled');
  await db.query(
    `INSERT INTO sessions (id_hash, account_id, generation, created_at, last_activity_at,
       idle_expires_at, absolute_expires_at, authenticated_at, method, identity_provider,
       identity_subject)
     VALUES ($1, $2, $3, $4, $4, $5, $6, $4, $7, $8, $9)`,
    [
      hashSecret(sid),
      s.accountId,
      Number(g.g),
      now,
      now + IDLE_MS,
      now + ABSOLUTE_MS,
      s.method,
      s.identityProvider,
      s.identitySubject,
    ],
  );
  return sid;
}

/** The live session a cookie names, or null; touches its idle expiry at most once a minute. */
export async function loadSession(
  db: Queryable,
  sid: string | undefined,
  now: number,
): Promise<Session | null> {
  if (!sid || !/^[A-Za-z0-9_-]{43}$/.test(sid)) return null;
  const idHash = hashSecret(sid);
  const r = await db.query<{
    account_id: string;
    created_at: string;
    authenticated_at: string;
    method: string;
    identity_provider: string;
    identity_subject: string;
    absolute_expires_at: string;
    last_activity_at: string;
  }>(
    `SELECT s.account_id, s.created_at, s.authenticated_at, s.method, s.identity_provider,
            s.identity_subject, s.absolute_expires_at, s.last_activity_at
       FROM sessions s JOIN accounts a ON a.id = s.account_id
      WHERE s.id_hash = $1
        AND s.revoked_at IS NULL
        AND s.idle_expires_at > $2
        AND s.absolute_expires_at > $2
        AND a.disabled_at IS NULL
        AND s.generation = a.session_generation`,
    [idHash, now],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (now - Number(row.last_activity_at) >= TOUCH_EVERY_MS) {
    await db.query(
      `UPDATE sessions SET last_activity_at = $2::bigint,
              idle_expires_at = LEAST($2::bigint + $3::bigint, absolute_expires_at)
        WHERE id_hash = $1`,
      [idHash, now, IDLE_MS],
    );
  }
  return {
    idHash,
    accountId: row.account_id,
    createdAt: Number(row.created_at),
    authenticatedAt: Number(row.authenticated_at),
    method: row.method,
    identityProvider: row.identity_provider,
    identitySubject: row.identity_subject,
    absoluteExpiresAt: Number(row.absolute_expires_at),
  };
}

/** Signed in within FRESH_MS — required before any sensitive action (ADR 620 decision 7). */
export function isFresh(s: Session, now: number): boolean {
  return now - s.authenticatedAt <= FRESH_MS;
}

export async function revokeSession(
  db: Queryable,
  idHash: string,
  reason: string,
  now: number,
): Promise<void> {
  await db.query(
    `UPDATE sessions SET revoked_at = $2, revoke_reason = $3
      WHERE id_hash = $1 AND revoked_at IS NULL`,
    [idHash, now, reason],
  );
}

/** Revoke every session of an account at once: bump its generation. */
export async function revokeAllSessions(db: Queryable, accountId: string): Promise<void> {
  await db.query('UPDATE accounts SET session_generation = session_generation + 1 WHERE id = $1', [
    accountId,
  ]);
}
