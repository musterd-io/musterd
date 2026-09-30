import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  OAUTH_ACCESS_TTL_S,
  OAUTH_CODE_TTL_S,
  OAUTH_REFRESH_TTL_S,
  TOKEN_PREFIXES,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { MusterdError } from '../errors.js';
import { hashToken, memberStandingRefusal, newSecret } from './members.js';
import type { MemberRow } from './rows.js';

/**
 * The OAuth 2.1 store (ADR 446) — phone-app clients, single-use authorization codes, and the
 * `msat_`/`msrt_` token pairs behind `/mcp/:team`.
 *
 * Secrets discipline (SPEC A.2, ADR 069): `randomBytes(32)` codes, `prefix + base64url` tokens,
 * stored ONLY as sha256; plaintext is returned once and never re-fetchable, never logged, never
 * in audit `detail`. Every redeem path is transactional (check-and-burn in one tx) so a code
 * replay or refresh race fails closed.
 */

export interface OAuthClientRow {
  client_id: string;
  team_id: string;
  client_name: string;
  redirect_uris: string;
  client_secret_hash: string | null;
  auth_method: string;
  created_at: number;
}

export interface OAuthCodeMint {
  code: string;
  expires_at: number;
}

export interface OAuthTokenPair {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export type OAuthClientSource = 'dcr' | 'cimd';

/** PKCE S256 verifier → challenge: `base64url(sha256(verifier))`, constant-time compared. */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

/** Mint a `cid_`-prefixed client id — opaque, never a secret (no hash, safe to log). */
function newClientId(): string {
  return `cid_${randomBytes(16).toString('base64url')}`;
}

/** Ensure a Team owns this exact public client ID without persisting CIMD metadata. */
async function ensureClientBinding(
  db: Driver,
  teamId: string,
  clientId: string,
  source: OAuthClientSource,
): Promise<void> {
  await db.run(
    `INSERT INTO oauth_client_bindings (team_id, client_id, source)
     VALUES (?, ?, ?) ON CONFLICT(team_id, client_id) DO NOTHING`,
    [teamId, clientId, source],
  );
  const binding = await db.get<{ source: OAuthClientSource }>(
    'SELECT source FROM oauth_client_bindings WHERE team_id = ? AND client_id = ?',
    [teamId, clientId],
  );
  if (binding?.source !== source)
    throw new MusterdError('conflict', 'OAuth client binding source mismatch');
}

/**
 * Register a phone-app client (RFC 7591). Public clients only in increment 1 — both phone apps
 * are public, and a confidential secret needs a typed prefix the ADR does not define yet
 * (increment 3). Redirect URIs are validated by the route, not here; they store as JSON.
 */
export async function registerClient(
  db: Driver,
  input: { teamId: string; clientName: string; redirectUris: string[] },
  now = Date.now(),
): Promise<{ client_id: string }> {
  const client_id = newClientId();
  await db.tx(async (t) => {
    await t.run(
      `INSERT INTO oauth_clients (client_id, team_id, client_name, redirect_uris, auth_method, created_at)
       VALUES (?, ?, ?, ?, 'none', ?)`,
      [client_id, input.teamId, input.clientName, JSON.stringify(input.redirectUris), now],
    );
    await ensureClientBinding(t, input.teamId, client_id, 'dcr');
  });
  return { client_id };
}

export async function getClient(
  db: Driver,
  teamId: string,
  clientId: string,
): Promise<OAuthClientRow> {
  const row = await db.get<OAuthClientRow>(
    'SELECT * FROM oauth_clients WHERE team_id = ? AND client_id = ?',
    [teamId, clientId],
  );
  if (!row) throw new MusterdError('not_found', `unknown OAuth client for this team`);
  return row;
}

/**
 * Issue a single-use authorization code (90s TTL) bound to
 * `client_id + redirect_uri + code_challenge + team + member`. The plaintext crosses exactly
 * one 302 `Location` (the flow both apps require) and is never stored.
 */
export async function issueCode(
  db: Driver,
  input: {
    teamId: string;
    memberId: string;
    clientId: string;
    redirectUri: string;
    codeChallenge: string;
    scope?: string;
    clientSource?: OAuthClientSource;
    /** ADR 456 §3: who connected this device (an agent connect's issuer); omitted for self-sign-in. */
    connectedBy?: string | null;
  },
  now = Date.now(),
): Promise<OAuthCodeMint> {
  const code = randomBytes(32).toString('base64url');
  const expires_at = now + OAUTH_CODE_TTL_S * 1000;
  const INSERT_CODE = `INSERT INTO oauth_codes
       (code_hash, team_id, member_id, client_id, redirect_uri, code_challenge, scope, created_at, expires_at, connected_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.tx(async (t) => {
    await ensureClientBinding(t, input.teamId, input.clientId, input.clientSource ?? 'dcr');
    await t.run(INSERT_CODE, [
      hashToken(code),
      input.teamId,
      input.memberId,
      input.clientId,
      input.redirectUri,
      input.codeChallenge,
      input.scope ?? null,
      now,
      expires_at,
      input.connectedBy ?? null,
    ]);
  });
  return { code, expires_at };
}

/**
 * Redeem a code for its seat (transactional check-and-burn: verify PKCE `S256`, redirect exact
 * match, TTL, single-use — then burn). Any failure throws; a replay of a burned code throws.
 */
export async function redeemCode(
  db: Driver,
  input: { teamId: string; clientId: string; code: string; redirectUri: string; verifier: string },
  now = Date.now(),
): Promise<{ memberId: string; scope: string | null; connectedBy: string | null }> {
  return db.tx(async (t) => {
    const row = await t.get<{
      team_id: string;
      member_id: string;
      connected_by: string | null;
      client_id: string;
      redirect_uri: string;
      code_challenge: string;
      scope: string | null;
      expires_at: number;
      used_at: number | null;
    }>('SELECT * FROM oauth_codes WHERE code_hash = ?', [hashToken(input.code)]);
    if (!row || row.team_id !== input.teamId || row.client_id !== input.clientId)
      throw new MusterdError('unauthorized', 'invalid authorization code');
    if (row.used_at !== null) throw new MusterdError('unauthorized', 'authorization code replayed');
    if (row.expires_at <= now) throw new MusterdError('unauthorized', 'authorization code expired');
    if (row.redirect_uri !== input.redirectUri)
      throw new MusterdError('unauthorized', 'redirect_uri mismatch');
    if (!safeEqual(pkceChallenge(input.verifier), row.code_challenge))
      throw new MusterdError('unauthorized', 'PKCE verification failed');
    await t.run('UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?', [
      now,
      hashToken(input.code),
    ]);
    return { memberId: row.member_id, scope: row.scope, connectedBy: row.connected_by };
  });
}

/**
 * A member's hard end, if they have one — the cap every access and refresh expiry takes
 * (ADR 449 §1, landed by ADR 452 §4): `min(kind TTL, lifecycle_until)`. `authMember` still enforces
 * expiry at use; the cap keeps what a client is told about its lifetime true.
 */
async function memberEnd(db: Driver, memberId: string): Promise<number | null> {
  const row = await db.get<{ lifecycle: string | null; lifecycle_until: number | null }>(
    'SELECT lifecycle, lifecycle_until FROM members WHERE id = ?',
    [memberId],
  );
  return row?.lifecycle === 'until' && row.lifecycle_until !== null ? row.lifecycle_until : null;
}

function cappedExpiries(
  end: number | null,
  now: number,
  refreshCeiling = now + OAUTH_REFRESH_TTL_S * 1000,
): { access: number; refresh: number; expires_in: number } {
  const access = Math.min(now + OAUTH_ACCESS_TTL_S * 1000, end ?? Infinity);
  const refresh = Math.min(refreshCeiling, end ?? Infinity);
  return { access, refresh, expires_in: Math.max(0, Math.floor((access - now) / 1000)) };
}

/** Mint a fresh access + refresh pair on one chain — the chain id is what reuse revokes. */
export async function mintTokenPair(
  db: Driver,
  input: {
    teamId: string;
    memberId: string;
    clientId: string;
    scope?: string | null;
    /** ADR 456 §3: the member whose standing bounds this chain beside the seat's own. */
    connectedBy?: string | null;
  },
  now = Date.now(),
): Promise<OAuthTokenPair> {
  const access_token = newSecret(TOKEN_PREFIXES.oauth_access);
  const refresh_token = newSecret(TOKEN_PREFIXES.oauth_refresh);
  const chain_id = ulid();
  const exp = cappedExpiries(await memberEnd(db, input.memberId), now);
  const INS = `INSERT INTO oauth_tokens
       (token_hash, kind, team_id, member_id, client_id, chain_id, scope, created_at, expires_at, connected_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  await db.tx(async (t) => {
    await t.run(INS, [
      hashToken(access_token),
      'access',
      input.teamId,
      input.memberId,
      input.clientId,
      chain_id,
      input.scope ?? null,
      now,
      exp.access,
      input.connectedBy ?? null,
    ]);
    await t.run(INS, [
      hashToken(refresh_token),
      'refresh',
      input.teamId,
      input.memberId,
      input.clientId,
      chain_id,
      input.scope ?? null,
      now,
      exp.refresh,
      input.connectedBy ?? null,
    ]);
  });
  return { access_token, refresh_token, expires_in: exp.expires_in };
}

/**
 * Rotate a refresh token: burn the presented one, mint a new pair on the SAME chain (sliding
 * window capped by the chain's first refresh expiry — the row it replaces carries the cap, and
 * the new refresh inherits `expires_at` no later than the burned one's).
 *
 * Reuse of a burned refresh is the stolen-token signal: revoke the WHOLE chain and throw — the
 * legitimate holder's next use fails closed too, which is the point (both sides re-authenticate).
 */
export async function rotateRefresh(
  db: Driver,
  input: { teamId: string; clientId: string; refreshToken: string },
  now = Date.now(),
): Promise<OAuthTokenPair> {
  // NOTE: the reuse branch writes (chain revocation) and then must THROW — a throw inside the
  // transaction would roll the revocation back, so the tx returns a verdict and the throw happens
  // outside it. Failure paths before any write throw inside freely.
  const outcome = await db.tx(
    async (t): Promise<{ pair: OAuthTokenPair } | { reused: true } | { ended: MusterdError }> => {
      const row = await t.get<{
        team_id: string;
        member_id: string;
        client_id: string;
        chain_id: string;
        scope: string | null;
        expires_at: number;
        replaced_at: number | null;
        revoked_at: number | null;
        connected_by: string | null;
      }>("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'", [
        hashToken(input.refreshToken),
      ]);
      if (!row || row.team_id !== input.teamId || row.client_id !== input.clientId)
        throw new MusterdError('unauthorized', 'invalid refresh token');
      if (row.revoked_at !== null)
        throw new MusterdError('unauthorized', 'refresh token revoked — sign in again');
      if (row.expires_at <= now)
        throw new MusterdError('unauthorized', 'refresh token expired — sign in again');
      if (row.replaced_at !== null) {
        // Burned refresh presented again: stolen-refresh detection — revoke the chain. This write
        // COMMITS (the verdict is thrown outside the tx); the legitimate holder fails closed too,
        // which is the point — both sides re-authenticate.
        await t.run(
          'UPDATE oauth_tokens SET revoked_at = ? WHERE chain_id = ? AND revoked_at IS NULL',
          [now, row.chain_id],
        );
        return { reused: true };
      }
      // ADR 452 §4: a member who left, was disabled, or expired gets no fresh pair — and the whole
      // chain dies with the refusal (committed: the verdict is thrown outside the tx), so a later
      // re-enable does not quietly revive a chain nobody re-authorized.
      const owner = await t.get<MemberRow>('SELECT * FROM members WHERE id = ?', [row.member_id]);
      // ADR 456 §3: so does one whose connector (the member who connected this device) lost theirs.
      const ended = owner
        ? (memberStandingRefusal(owner, now) ?? (await connectorRefusal(t, row.connected_by, now)))
        : new MusterdError('unauthorized', 'seat is gone');
      if (ended) {
        await t.run(
          'UPDATE oauth_tokens SET revoked_at = ? WHERE chain_id = ? AND revoked_at IS NULL',
          [now, row.chain_id],
        );
        return { ended };
      }
      await t.run('UPDATE oauth_tokens SET replaced_at = ? WHERE token_hash = ?', [
        now,
        hashToken(input.refreshToken),
      ]);
      const access_token = newSecret(TOKEN_PREFIXES.oauth_access);
      const refresh_token = newSecret(TOKEN_PREFIXES.oauth_refresh);
      // Sliding cap: the new refresh never outlives the burned one's expiry (first-login + 30d),
      // nor the member's own end (ADR 449 §1).
      const exp = cappedExpiries(await memberEnd(t, row.member_id), now, row.expires_at);
      const refreshExpires = exp.refresh;
      const INS = `INSERT INTO oauth_tokens
         (token_hash, kind, team_id, member_id, client_id, chain_id, scope, created_at, expires_at, connected_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
      await t.run(INS, [
        hashToken(access_token),
        'access',
        row.team_id,
        row.member_id,
        row.client_id,
        row.chain_id,
        row.scope,
        now,
        exp.access,
        row.connected_by,
      ]);
      await t.run(INS, [
        hashToken(refresh_token),
        'refresh',
        row.team_id,
        row.member_id,
        row.client_id,
        row.chain_id,
        row.scope,
        now,
        refreshExpires,
        row.connected_by,
      ]);
      return { pair: { access_token, refresh_token, expires_in: exp.expires_in } };
    },
  );
  if ('ended' in outcome) throw outcome.ended;
  if ('reused' in outcome)
    throw new MusterdError(
      'unauthorized',
      'refresh token reused — the chain is revoked, sign in again',
    );
  return outcome.pair;
}

/**
 * Best-effort owner lookup for audit rows (never a secret back): the member name behind either
 * kind of token, or null when the token names nothing. Audit-only — authorization never consults
 * it, so an unknown token stays an unknown token everywhere else.
 */
export async function chainMember(
  db: Driver,
  teamId: string,
  clientId: string | null,
  token: string,
): Promise<string | null> {
  const row = await db.get<{ team_id: string; client_id: string; member_id: string }>(
    'SELECT team_id, client_id, member_id FROM oauth_tokens WHERE token_hash = ?',
    [hashToken(token)],
  );
  if (!row || row.team_id !== teamId) return null;
  if (clientId !== null && row.client_id !== clientId) return null;
  return (
    (await db.get<{ name: string }>('SELECT name FROM members WHERE id = ?', [row.member_id]))
      ?.name ?? null
  );
}

/** RFC 7009 revocation — either kind; a refresh revocation also burns its live access sibling. */ export async function revokeToken(
  db: Driver,
  teamId: string,
  token: string,
  now = Date.now(),
): Promise<boolean> {
  const row = await db.get<{
    team_id: string;
    kind: string;
    chain_id: string;
    revoked_at: number | null;
  }>('SELECT team_id, kind, chain_id, revoked_at FROM oauth_tokens WHERE token_hash = ?', [
    hashToken(token),
  ]);
  if (!row || row.team_id !== teamId || row.revoked_at !== null) return false;
  await db.run('UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?', [
    now,
    hashToken(token),
  ]);
  if (row.kind === 'refresh')
    await db.run(
      "UPDATE oauth_tokens SET revoked_at = ? WHERE chain_id = ? AND kind = 'access' AND revoked_at IS NULL",
      [now, row.chain_id],
    );
  return true;
}

/** Admin revoke-all per seat — rides the credential-rotate path (ADR 446 §3). */
export async function revokeAllForMember(
  db: Driver,
  teamId: string,
  memberId: string,
  now = Date.now(),
): Promise<number> {
  const res = await db.run(
    'UPDATE oauth_tokens SET revoked_at = ? WHERE team_id = ? AND member_id = ? AND revoked_at IS NULL',
    [now, teamId, memberId],
  );
  return Number(res.changes);
}

/**
 * Burn every authorization code bound to `memberId` that has not been exchanged yet (ADR 452 §2.3):
 * `used_at` set, so `redeemCode` refuses it as replayed. With `revokeAllForMember` this is the
 * whole of a supersede — chains AND codes — because a 90s code from an earlier connect would pass
 * every other check (the agent is live) and mint a second chain. Returns how many it burned.
 */
export async function burnUnexchangedCodes(
  db: Driver,
  teamId: string,
  memberId: string,
  now = Date.now(),
): Promise<number> {
  const res = await db.run(
    'UPDATE oauth_codes SET used_at = ? WHERE team_id = ? AND member_id = ? AND used_at IS NULL',
    [now, teamId, memberId],
  );
  return Number(res.changes);
}

/**
 * ADR 456 §3: why a chain's connector no longer bounds it — the member who connected the device has
 * left, been disabled/banned/archived, or expired — or null (including a chain with no connector,
 * i.e. a human who signed their own seat in).
 */
export async function connectorRefusal(
  db: Driver,
  connectedBy: string | null,
  now = Date.now(),
): Promise<MusterdError | null> {
  if (connectedBy === null) return null;
  const connector = await db.get<MemberRow>('SELECT * FROM members WHERE id = ?', [connectedBy]);
  if (connector && !memberStandingRefusal(connector, now)) return null;
  return new MusterdError(
    'unauthorized',
    'the member who connected this device is no longer on the team — connect it again',
  );
}

/**
 * Verify an `msat_` bearer for `authMember`: same seat proof as `mscr_` (hash-bound member,
 * acting-seat must match-or-absent is checked by the caller) with NO session lease. Returns the
 * live row or throws — expired, revoked, cross-team, and departed seats all fail closed. The row
 * is a human, or (ADR 452 §3) an agent whose chain came from a redeemed connect nonce — the only
 * way an agent-bound code is ever issued — and then (ADR 456 §3) only while its connector stands.
 */
export async function verifyAccess(
  db: Driver,
  teamId: string,
  accessToken: string,
  now = Date.now(),
): Promise<MemberRow> {
  const row = await db.get<{
    member_id: string;
    team_id: string;
    expires_at: number;
    revoked_at: number | null;
    connected_by: string | null;
  }>(
    "SELECT member_id, team_id, expires_at, revoked_at, connected_by FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'",
    [hashToken(accessToken)],
  );
  if (!row || row.team_id !== teamId || row.revoked_at !== null || row.expires_at <= now)
    throw new MusterdError('unauthorized', `invalid access token for this team`);
  const member = await db.get<MemberRow>(
    "SELECT * FROM members WHERE team_id = ? AND id = ? AND left_at IS NULL AND kind IN ('human', 'agent')",
    [teamId, row.member_id],
  );
  if (!member) throw new MusterdError('unauthorized', 'access token names a seat that is gone');
  const connector = await connectorRefusal(db, row.connected_by, now);
  if (connector) throw connector;
  return member;
}
