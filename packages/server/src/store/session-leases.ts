import { TOKEN_PREFIXES } from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { newSecret, hashToken } from './members.js';

/** Five minutes limits replay exposure while avoiding renewal on every routine HTTP call (ADR 337). */
export const AGENT_SESSION_LEASE_TTL_MS = 5 * 60_000;
/**
 * How long before expiry a live WS connection is handed a renewed lease (ADR 347). Two minutes of a
 * five-minute lease: eight adapter heartbeats (15 s) fall inside the window, so one dropped
 * heartbeat never leaves an adapter without authority. Measured 2026-09-01: with no renewal at all,
 * every adapter's HTTP tools died five minutes after claim (lane 01M1FC77F2).
 */
export const AGENT_SESSION_LEASE_RENEW_AHEAD_MS = 2 * 60_000;

export interface SessionLeaseMint {
  id: string;
  session_lease: string;
  expires_at: number;
}

/** Mint an opaque, Presence-bound lease. Only its hash reaches durable storage. */
export async function mintSessionLease(
  db: Driver,
  input: { teamId: string; memberId: string; presenceId: string },
  now = Date.now(),
): Promise<SessionLeaseMint> {
  const session_lease = newSecret(TOKEN_PREFIXES.session_lease);
  const lease: SessionLeaseMint = {
    id: ulid(),
    session_lease,
    expires_at: now + AGENT_SESSION_LEASE_TTL_MS,
  };
  await db.run(
    `INSERT INTO session_leases (id, team_id, member_id, presence_id, token_hash, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      lease.id,
      input.teamId,
      input.memberId,
      input.presenceId,
      hashToken(session_lease),
      lease.expires_at,
      now,
    ],
  );
  return lease;
}

/**
 * Is this lease (by id) due for renewal — still valid and expiring within `aheadMs`? Read from the
 * store, not from connection memory, so that a REVOKED lease is never renewed: revocation is ADR 337
 * §3's list (supersession, release, ban, archive, credential rotation) and a heartbeat must not undo
 * it — reconnection (§4) is the only way back. A lease that is gone is not renewed either.
 * dolly's review of #1154 probed the opposite reading: rotate the credential, one heartbeat, and a
 * live unrevoked lease existed again.
 */
export async function sessionLeaseDueForRenewal(
  db: Driver,
  leaseId: string,
  aheadMs: number,
  now = Date.now(),
): Promise<boolean> {
  const row = await db.get<{ expires_at: number; revoked_at: number | null }>(
    'SELECT expires_at, revoked_at FROM session_leases WHERE id = ?',
    [leaseId],
  );
  if (!row || row.revoked_at !== null) return false;
  return row.expires_at - now <= aheadMs;
}

/** A lease proves this exact agent still holds the Presence it received at claim time. */
export async function hasValidSessionLease(
  db: Driver,
  input: { teamId: string; memberId: string; token: string },
  now = Date.now(),
): Promise<boolean> {
  const row = await db.get<{ id: string }>(
    `SELECT l.id
       FROM session_leases l
       JOIN presence p ON p.id = l.presence_id
       WHERE l.team_id = ?
         AND l.member_id = ?
         AND l.token_hash = ?
         AND l.revoked_at IS NULL
         AND l.expires_at > ?
         AND p.held_until IS NULL`,
    [input.teamId, input.memberId, hashToken(input.token), now],
  );
  return Boolean(row);
}

/**
 * Lane 01M3TAKT16: why {@link hasValidSessionLease} said no — read only on the refusal path, so
 * the `interrupt.refused` row can tell the deaf-seat causes apart: a lease this daemon never
 * minted (`unknown` — a stale token after a reset, or a forgery), one revoked on purpose
 * (`revoked` — rotate, halt, a bounce), one past its TTL (`expired` — the renewal never reached
 * it), or one whose Presence was released under it (`presence_released`).
 *
 * ADR 511: a lease row is deleted with its Presence (ON DELETE CASCADE), so "no row" mostly means
 * the Presence it was bound to is gone — a session start presenting the previous session's lease
 * from binding.json, before its own adapter's first tool call has claimed. With no unheld Presence
 * on the seat at all, that session has not joined (`not_joined`), and it is not a deaf seat: its
 * first inbox read delivers what waits. `unknown` is kept for a lease the daemon cannot place while
 * some Presence DOES hold the seat — a binding that missed the live occupant's lease.
 */
export async function diagnoseSessionLease(
  db: Driver,
  input: { teamId: string; memberId: string; token: string },
  now = Date.now(),
): Promise<'revoked' | 'expired' | 'presence_released' | 'not_joined' | 'unknown'> {
  const row = await db.get<{ revoked_at: number | null; expires_at: number; held: number | null }>(
    `SELECT l.revoked_at, l.expires_at, p.held_until AS held
       FROM session_leases l
       LEFT JOIN presence p ON p.id = l.presence_id
       WHERE l.team_id = ? AND l.member_id = ? AND l.token_hash = ?`,
    [input.teamId, input.memberId, hashToken(input.token)],
  );
  if (!row) {
    const live = await db.get<{ id: string }>(
      'SELECT id FROM presence WHERE member_id = ? AND held_until IS NULL LIMIT 1',
      [input.memberId],
    );
    return live ? 'unknown' : 'not_joined';
  }
  if (row.revoked_at !== null) return 'revoked';
  if (row.expires_at <= now) return 'expired';
  return 'presence_released';
}

/** Mark outstanding leases dead before a lifecycle transition that retains their Presence rows. */
export async function revokeMemberSessionLeases(
  db: Driver,
  memberId: string,
  now = Date.now(),
): Promise<string[]> {
  const leases = (
    await db.all<{ id: string }>(
      'SELECT id FROM session_leases WHERE member_id = ? AND revoked_at IS NULL',
      [memberId],
    )
  ).map((row) => row.id);
  if (leases.length > 0)
    await db.run(
      'UPDATE session_leases SET revoked_at = ? WHERE member_id = ? AND revoked_at IS NULL',
      [now, memberId],
    );
  return leases;
}
