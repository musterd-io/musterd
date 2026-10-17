import { randomUUID } from 'node:crypto';
import type { Queryable } from './db.js';
import type { ProviderIdentity } from './providers.js';

/**
 * The account an identity belongs to (ADR 620 decisions 3–4). An identity is `(provider, subject)`
 * and nothing else: a matching email never selects an existing account, so a new identity always
 * makes a new account. Returns null for a disabled account. Two first sign-ins racing on the same
 * identity both insert an account; the identity's primary key picks one winner, and the other's
 * empty account is left unreferenced (harmless; the maintenance role prunes it).
 */
export async function accountFor(
  db: Queryable,
  id: ProviderIdentity,
  now: number,
): Promise<{ accountId: string; created: boolean } | null> {
  const found = await existing(db, id);
  if (found) {
    if (found.disabled) return null;
    await db.query('UPDATE identities SET last_used_at = $3 WHERE provider = $1 AND subject = $2', [
      id.provider,
      id.subject,
      now,
    ]);
    return { accountId: found.accountId, created: false };
  }
  const accountId = `acc_${randomUUID().replace(/-/g, '')}`;
  await db.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', [accountId, now]);
  const ins = await db.query<{ account_id: string }>(
    `INSERT INTO identities (provider, subject, account_id, email, created_at, last_used_at)
     VALUES ($1, $2, $3, $4, $5, $5)
     ON CONFLICT (provider, subject) DO NOTHING
     RETURNING account_id`,
    [id.provider, id.subject, accountId, id.email, now],
  );
  if (ins.rows[0]) return { accountId, created: true };
  const winner = await existing(db, id);
  if (!winner || winner.disabled) return null;
  return { accountId: winner.accountId, created: false };
}

async function existing(db: Queryable, id: ProviderIdentity) {
  const r = await db.query<{ account_id: string; disabled_at: string | null }>(
    `SELECT i.account_id, a.disabled_at FROM identities i JOIN accounts a ON a.id = i.account_id
      WHERE i.provider = $1 AND i.subject = $2`,
    [id.provider, id.subject],
  );
  const row = r.rows[0];
  return row ? { accountId: row.account_id, disabled: row.disabled_at !== null } : null;
}

/**
 * The sign-in methods an account holds, for the signed-in page. Subjects stay off the result.
 * Pass the session's identity and `current` is true on that one row (copy spec §6).
 */
export async function methodsOf(
  db: Queryable,
  accountId: string,
  current?: { provider: string; subject: string },
): Promise<{ provider: string; email: string | null; current: boolean }[]> {
  const r = await db.query<{ provider: string; email: string | null; subject: string }>(
    'SELECT provider, email, subject FROM identities WHERE account_id = $1 ORDER BY created_at',
    [accountId],
  );
  return r.rows.map((row) => ({
    provider: row.provider,
    email: row.email,
    current:
      current !== undefined && row.provider === current.provider && row.subject === current.subject,
  }));
}
