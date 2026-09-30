import { type Grant, type GrantMint, type IssueGrant, TOKEN_PREFIXES } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { hashToken, newSecret } from './members.js';

/**
 * The grant store (ADR 076, P3.1 of ADR 069). A grant is an admin-issued authorization for a session to
 * claim a seat or role. The secret `msgr_…` token is stored **only** as its sha256 hash (SPEC A.2) and
 * returned once at mint; validation hashes the presented token and looks it up. Nothing here is wired
 * into auth yet — the claim handshake (ADR 077) consumes grants at the P3 cutover.
 */

export interface GrantRow {
  id: string;
  team_id: string;
  scope: string;
  target: string;
  token_hash: string;
  issued_by: string | null;
  lifetime: string;
  expires_at: number | null;
  single_use: number; // 0 | 1
  revoked: number; // 0 | 1
  created_at: number;
}

/** Project a stored row to the public {@link Grant} shape — never includes the token hash. */
export function toGrant(row: GrantRow): Grant {
  return {
    id: row.id,
    team: row.team_id,
    scope: row.scope as Grant['scope'],
    target: row.target,
    issued_by: row.issued_by,
    lifetime: row.lifetime as Grant['lifetime'],
    expires_at: row.expires_at,
    single_use: row.single_use === 1,
    revoked: row.revoked === 1,
    created_at: row.created_at,
  };
}

/**
 * Issue a grant: mint a fresh `msgr_` token, store its hash, and return the grant + plaintext token
 * (shown **once**). `once` lifetime implies `single_use`; `ttl` sets `expires_at = now + ttl_hours`.
 */
export async function issueGrant(
  db: Driver,
  teamId: string,
  input: IssueGrant,
  issuedBy: string | null,
): Promise<GrantMint> {
  const now = Date.now();
  const token = newSecret(TOKEN_PREFIXES.grant);
  const expiresAt =
    input.lifetime === 'ttl' && input.ttl_hours != null
      ? now + Math.round(input.ttl_hours * 3_600_000)
      : null;
  const singleUse = input.lifetime === 'once' ? 1 : input.single_use ? 1 : 0;
  const row: GrantRow = {
    id: ulid(),
    team_id: teamId,
    scope: input.scope,
    target: input.target,
    token_hash: hashToken(token),
    issued_by: issuedBy,
    lifetime: input.lifetime,
    expires_at: expiresAt,
    single_use: singleUse,
    revoked: 0,
    created_at: now,
  };
  await db.run(
    `INSERT INTO grants (id, team_id, scope, target, token_hash, issued_by, lifetime, expires_at,
                         single_use, revoked, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?,
             ?, ?, ?)`,
    [
      row.id,
      row.team_id,
      row.scope,
      row.target,
      row.token_hash,
      row.issued_by,
      row.lifetime,
      row.expires_at,
      row.single_use,
      row.revoked,
      row.created_at,
    ],
  );
  return { grant: toGrant(row), token };
}

/** Why a presented grant token is not usable — distinguishes the {@link validateGrant} failure modes. */
export type GrantInvalid = 'not_found' | 'revoked' | 'expired';

/**
 * Validate a presented grant token: hash → look up (team-scoped) → check revoked/expired. Returns the
 * row on success (the caller consumes a `single_use` grant via {@link consumeGrant} on a successful
 * claim — separating validation from consumption so a failed claim doesn't burn a once-grant).
 */
export async function validateGrant(
  db: Driver,
  teamId: string,
  token: string,
): Promise<{ ok: true; grant: GrantRow } | { ok: false; reason: GrantInvalid }> {
  const row = await db.get<GrantRow>('SELECT * FROM grants WHERE team_id = ? AND token_hash = ?', [
    teamId,
    hashToken(token),
  ]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.revoked === 1) return { ok: false, reason: 'revoked' };
  if (row.expires_at != null && row.expires_at <= Date.now())
    return { ok: false, reason: 'expired' };
  return { ok: true, grant: row };
}

/** Consume a `single_use` grant after a successful claim — marks it revoked so it can't be reused. */
export async function consumeGrant(db: Driver, id: string): Promise<void> {
  await db.run('UPDATE grants SET revoked = 1 WHERE id = ? AND single_use = 1', [id]);
}

/**
 * Refresh a reusable grant's TTL on a successful occupy (ADR 087 resume token): bumps `expires_at` to
 * `now + ttlMs` so an actively-used seat never expires — only genuine idleness past the window does.
 * Guarded to non-single-use, non-revoked, TTL-bearing grants (a `standing` grant has `expires_at NULL`
 * and is left untouched; a `once` grant is never refreshed). No-op if none match.
 */
export async function refreshGrant(db: Driver, id: string, ttlMs: number): Promise<void> {
  await db.run(
    'UPDATE grants SET expires_at = ? WHERE id = ? AND single_use = 0 AND revoked = 0 AND expires_at IS NOT NULL',
    [Date.now() + ttlMs, id],
  );
}

/** Admin revoke. Returns true if a matching, not-already-revoked grant was revoked. */
export async function revokeGrant(db: Driver, teamId: string, id: string): Promise<boolean> {
  const res = await db.run(
    'UPDATE grants SET revoked = 1 WHERE team_id = ? AND id = ? AND revoked = 0',
    [teamId, id],
  );
  return res.changes > 0;
}

/** List a team's grants (public shape), newest-first. */
export async function listGrants(db: Driver, teamId: string): Promise<Grant[]> {
  return (
    await db.all<GrantRow>(
      'SELECT * FROM grants WHERE team_id = ? ORDER BY created_at DESC, id DESC',
      [teamId],
    )
  ).map(toGrant);
}
