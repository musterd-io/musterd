import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { hashToken } from './members.js';

/**
 * The one-time state behind a hosted `/live` sign-in (ADR 722 §1–2). `start` writes a row holding
 * only the sha256 of a random `state` and hands the plaintext back once — it rides the
 * `__Host-musterd_signin` cookie and the console round trip, and the callback consumes the row
 * exactly once whatever the outcome. A `link` pins the member who started it; an `invite` carries
 * the invite's id and the stranger's chosen name — the secret was checked at start and is never
 * stored. Rows are pruned on the way in, an hour past expiry.
 */

export const SIGNIN_STATE_TTL_MS = 10 * 60_000;
const PRUNE_AFTER_MS = 60 * 60_000;

export type SigninMode = 'signin' | 'invite' | 'link';

export interface SigninStateRow {
  id: string;
  team_id: string;
  state_hash: string;
  mode: SigninMode;
  member_id: string | null;
  invite_id: string | null;
  name: string | null;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
}

export type SigninStateOutcome =
  | { ok: true; record: SigninStateRow }
  | { ok: false; reason: 'unknown' | 'spent' | 'expired' };

export async function startSigninState(
  db: Driver,
  input: { teamId: string; mode: SigninMode; memberId?: string; inviteId?: string; name?: string },
  now = Date.now(),
): Promise<{ id: string; state: string; expires_at: number }> {
  await db.run('DELETE FROM signin_states WHERE team_id = ? AND expires_at < ?', [
    input.teamId,
    now - PRUNE_AFTER_MS,
  ]);
  const id = ulid();
  // 32 random bytes, no prefix: the state is a handle, not a credential, and authorizes nothing
  // on its own (ADR 722 §1).
  const state = randomBytes(32).toString('base64url');
  const expires_at = now + SIGNIN_STATE_TTL_MS;
  await db.run(
    `INSERT INTO signin_states (id, team_id, state_hash, mode, member_id, invite_id, name, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.teamId,
      hashToken(state),
      input.mode,
      input.memberId ?? null,
      input.inviteId ?? null,
      input.name ?? null,
      now,
      expires_at,
    ],
  );
  return { id, state, expires_at };
}

/** Consume the state once. A spent or expired row is refused and stays spent. */
export async function consumeSigninState(
  db: Driver,
  teamId: string,
  state: string,
  now = Date.now(),
): Promise<SigninStateOutcome> {
  return await db.tx(async (t) => {
    const row = await t.get<SigninStateRow>(
      'SELECT * FROM signin_states WHERE team_id = ? AND state_hash = ?',
      [teamId, hashToken(state)],
    );
    if (!row) return { ok: false, reason: 'unknown' };
    if (row.consumed_at !== null) return { ok: false, reason: 'spent' };
    await t.run('UPDATE signin_states SET consumed_at = ? WHERE id = ?', [now, row.id]);
    if (row.expires_at <= now) return { ok: false, reason: 'expired' };
    return { ok: true, record: { ...row, consumed_at: now } };
  });
}
