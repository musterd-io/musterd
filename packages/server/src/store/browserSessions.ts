import { randomBytes } from 'node:crypto';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { hashToken } from './members.js';

/**
 * Browser sessions (ADR 722 §3–4): the row behind the `__Host-musterd_s` cookie on a hosted team.
 * The `mbs_` secret is returned once and stored only as a sha256; it is never a bearer — the only
 * thing it buys is `POST /live/session/token`, a 15-minute `msat_`. 14 days absolute, 3 days idle
 * (read against `last_used_at`, which every successful resolve touches), revocable per session.
 * `label` is a user-agent family, never the full string (hard rule 5: nothing identifying lands).
 */

/** Never sent as a bearer; `authMember` refuses the prefix like any unknown one. */
export const BROWSER_SESSION_PREFIX = 'mbs_';
export const BROWSER_SESSION_ABSOLUTE_MS = 14 * 24 * 60 * 60_000;
export const BROWSER_SESSION_IDLE_MS = 3 * 24 * 60 * 60_000;

export interface BrowserSessionRow {
  id: string;
  team_id: string;
  member_id: string;
  secret_hash: string;
  label: string;
  created_at: number;
  last_used_at: number;
  expires_at: number;
  revoked_at: number | null;
}

/** What a list hands out: the row without its hash. */
export type BrowserSessionSummary = Omit<BrowserSessionRow, 'secret_hash'>;

export type ResolveOutcome =
  | { ok: true; session: BrowserSessionSummary }
  | { ok: false; reason: 'unknown' | 'revoked' | 'idle' | 'expired' };

export async function createBrowserSession(
  db: Driver,
  input: { teamId: string; memberId: string; label: string },
  now = Date.now(),
): Promise<{ id: string; secret: string; expires_at: number }> {
  const id = ulid();
  // `mbs_` + 32 random bytes (ADR 722 §3).
  const secret = BROWSER_SESSION_PREFIX + randomBytes(32).toString('base64url');
  const expires_at = now + BROWSER_SESSION_ABSOLUTE_MS;
  await db.run(
    `INSERT INTO browser_sessions (id, team_id, member_id, secret_hash, label, created_at, last_used_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, input.teamId, input.memberId, hashToken(secret), input.label, now, now, expires_at],
  );
  return { id, secret, expires_at };
}

/** Resolve a cookie's secret to its live session, touching `last_used_at`; a refusal touches nothing. */
export async function resolveBrowserSession(
  db: Driver,
  teamId: string,
  secret: string,
  now = Date.now(),
): Promise<ResolveOutcome> {
  if (!secret.startsWith(BROWSER_SESSION_PREFIX)) return { ok: false, reason: 'unknown' };
  const row = await db.get<BrowserSessionRow>(
    'SELECT * FROM browser_sessions WHERE team_id = ? AND secret_hash = ?',
    [teamId, hashToken(secret)],
  );
  if (!row) return { ok: false, reason: 'unknown' };
  if (row.revoked_at !== null) return { ok: false, reason: 'revoked' };
  if (row.expires_at <= now) return { ok: false, reason: 'expired' };
  if (row.last_used_at + BROWSER_SESSION_IDLE_MS < now) return { ok: false, reason: 'idle' };
  await db.run('UPDATE browser_sessions SET last_used_at = ? WHERE id = ?', [now, row.id]);
  return { ok: true, session: summary({ ...row, last_used_at: now }) };
}

export async function getBrowserSession(
  db: Driver,
  teamId: string,
  id: string,
): Promise<BrowserSessionSummary | undefined> {
  const row = await db.get<BrowserSessionRow>(
    'SELECT * FROM browser_sessions WHERE team_id = ? AND id = ?',
    [teamId, id],
  );
  return row ? summary(row) : undefined;
}

/** A member's sessions, newest first, revoked rows included (the roster shows them struck). */
export async function listBrowserSessions(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<BrowserSessionSummary[]> {
  const rows = await db.all<BrowserSessionRow>(
    'SELECT * FROM browser_sessions WHERE team_id = ? AND member_id = ? ORDER BY created_at DESC, id DESC',
    [teamId, memberId],
  );
  return rows.map(summary);
}

/** True when a live row was revoked by this call. */
export async function revokeBrowserSession(
  db: Driver,
  teamId: string,
  id: string,
  now = Date.now(),
): Promise<boolean> {
  const r = await db.run(
    'UPDATE browser_sessions SET revoked_at = ? WHERE team_id = ? AND id = ? AND revoked_at IS NULL',
    [now, teamId, id],
  );
  return Number(r.changes) === 1;
}

/** Every live session of a member (credential rotate, ADR 722 §4). Returns the ids revoked. */
export async function revokeBrowserSessionsForMember(
  db: Driver,
  teamId: string,
  memberId: string,
  now = Date.now(),
): Promise<string[]> {
  return await db.tx(async (t) => {
    const rows = await t.all<{ id: string }>(
      'SELECT id FROM browser_sessions WHERE team_id = ? AND member_id = ? AND revoked_at IS NULL',
      [teamId, memberId],
    );
    if (rows.length === 0) return [];
    await t.run(
      'UPDATE browser_sessions SET revoked_at = ? WHERE team_id = ? AND member_id = ? AND revoked_at IS NULL',
      [now, teamId, memberId],
    );
    return rows.map((r) => r.id);
  });
}

/** A user-agent family for the roster's "Signed-in browsers" list — never the full string. */
export function sessionLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? '';
  if (/\bEdg(e|A|iOS)?\//.test(ua)) return 'Edge';
  if (/\bFirefox\//.test(ua) || /\bFxiOS\//.test(ua)) return 'Firefox';
  if (/\bChrome\//.test(ua) || /\bCriOS\//.test(ua)) return 'Chrome';
  if (/\bSafari\//.test(ua) && /\bVersion\//.test(ua)) return 'Safari';
  return 'browser';
}

function summary(row: BrowserSessionRow): BrowserSessionSummary {
  const { secret_hash: _hash, ...rest } = row;
  void _hash;
  return rest;
}
