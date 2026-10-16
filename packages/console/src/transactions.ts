import type { Queryable } from './db.js';
import { hashSecret, newSecret, sameSecret } from './secrets.js';

/**
 * Sign-in transactions (ADR 620 decision 5). One row per started flow, keyed by the hash of a
 * `__Host-tx` cookie set on the browser that started it. A callback must present that cookie, the
 * matching provider, the matching state, inside the TTL, and the row is consumed by one atomic
 * UPDATE … WHERE consumed_at IS NULL — so a replay, a second tab or a second server finds it gone.
 */
export const TX_COOKIE = '__Host-tx';
export const TX_TTL_MS = 10 * 60 * 1000;

export interface OAuthTx {
  provider: string;
  state: string;
  pkceVerifier: string;
  nonce: string | null;
  returnPath: string;
}

export async function createOAuthTx(db: Queryable, tx: OAuthTx, now: number): Promise<string> {
  const cookieValue = newSecret();
  await db.query(
    `INSERT INTO auth_transactions (id_hash, kind, provider, state_hash, pkce_verifier, nonce,
       return_path, created_at, expires_at)
     VALUES ($1, 'oauth', $2, $3, $4, $5, $6, $7, $8)`,
    [
      hashSecret(cookieValue),
      tx.provider,
      hashSecret(tx.state),
      tx.pkceVerifier,
      tx.nonce,
      tx.returnPath,
      now,
      now + TX_TTL_MS,
    ],
  );
  return cookieValue;
}

export const MAGIC_TTL_MS = 15 * 60 * 1000;

/** A magic-link transaction: the browser's tx cookie AND the emailed token, both hashed. */
export async function createMagicTx(
  db: Queryable,
  tx: { email: string; token: string; returnPath: string },
  now: number,
): Promise<string> {
  const cookieValue = newSecret();
  await db.query(
    `INSERT INTO auth_transactions (id_hash, kind, provider, email, token_hash, return_path,
       created_at, expires_at)
     VALUES ($1, 'magic', 'email', $2, $3, $4, $5, $6)`,
    [
      hashSecret(cookieValue),
      tx.email,
      hashSecret(tx.token),
      tx.returnPath,
      now,
      now + MAGIC_TTL_MS,
    ],
  );
  return cookieValue;
}

export type MagicLookup = 'confirm' | 'other_browser' | 'expired';

/**
 * What the link's GET may show — it never consumes (mail scanners and prefetchers GET links).
 * `confirm` only when the token is live AND this browser holds the transaction that asked.
 */
export async function lookupMagic(
  db: Queryable,
  token: string | null,
  cookieValue: string | undefined,
  now: number,
): Promise<MagicLookup> {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return 'expired';
  const r = await db.query<{ id_hash: string }>(
    `SELECT id_hash FROM auth_transactions
      WHERE token_hash = $1 AND kind = 'magic' AND consumed_at IS NULL AND expires_at > $2::bigint`,
    [hashSecret(token), now],
  );
  const row = r.rows[0];
  if (!row) return 'expired';
  return cookieValue && sameSecret(row.id_hash, hashSecret(cookieValue))
    ? 'confirm'
    : 'other_browser';
}

/** Consume a magic link: the token and this browser's tx cookie must name the same live row. */
export async function consumeMagic(
  db: Queryable,
  token: string | null,
  cookieValue: string | undefined,
  now: number,
): Promise<{ email: string; returnPath: string } | null> {
  if (
    !token ||
    !cookieValue ||
    !/^[A-Za-z0-9_-]{43}$/.test(token) ||
    !/^[A-Za-z0-9_-]{43}$/.test(cookieValue)
  )
    return null;
  const r = await db.query<{ email: string; return_path: string }>(
    `UPDATE auth_transactions SET consumed_at = $3::bigint
      WHERE token_hash = $1 AND id_hash = $2 AND kind = 'magic'
        AND consumed_at IS NULL AND expires_at > $3::bigint
      RETURNING email, return_path`,
    [hashSecret(token), hashSecret(cookieValue), now],
  );
  const row = r.rows[0];
  return row ? { email: row.email, returnPath: row.return_path } : null;
}

/**
 * Consume the transaction a callback names, or null. Null for: no cookie, unknown cookie, another
 * provider, expired, already consumed, or a state that does not match.
 */
export async function consumeOAuthTx(
  db: Queryable,
  cookieValue: string | undefined,
  provider: string,
  state: string | null,
  now: number,
): Promise<OAuthTx | null> {
  if (!cookieValue || !/^[A-Za-z0-9_-]{43}$/.test(cookieValue) || !state) return null;
  const r = await db.query<{
    state_hash: string;
    pkce_verifier: string;
    nonce: string | null;
    return_path: string;
  }>(
    `UPDATE auth_transactions SET consumed_at = $3::bigint
      WHERE id_hash = $1 AND kind = 'oauth' AND provider = $2
        AND consumed_at IS NULL AND expires_at > $3::bigint
      RETURNING state_hash, pkce_verifier, nonce, return_path`,
    [hashSecret(cookieValue), provider, now],
  );
  const row = r.rows[0];
  if (!row || !sameSecret(row.state_hash, hashSecret(state))) return null;
  return {
    provider,
    state,
    pkceVerifier: row.pkce_verifier,
    nonce: row.nonce,
    returnPath: row.return_path,
  };
}
