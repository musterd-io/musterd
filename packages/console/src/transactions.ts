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
