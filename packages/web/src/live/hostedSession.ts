/**
 * Hosted `/live` sign-in (ADR 722 §3, spec 2026-11-06 unified sign-in §5). The page asks the team's
 * own origin for a short access token in exchange for its `__Host-` session cookie. The answer says
 * which world this page is in:
 *
 *   404 (or no answer) — a self-hosted daemon: today's sign-in, unchanged (ADR 722 §5);
 *   401                — a hosted team, no browser session yet: show **Sign in with musterd**;
 *   200                — signed in: the member, the team, and a 15-minute `msat_`, held in memory only.
 *
 * The token is never written to storage; a refresh is the same call a minute before it expires.
 */

export type HostedSession =
  | { kind: 'self_hosted' }
  | { kind: 'signed_out' }
  | { kind: 'signed_in'; as: string; team: string; token: string; expiresAt: number };

/** Where **Sign in with musterd** goes: the team's own start route, which hands off to the console. */
export const SIGN_IN_PATH = '/live/signin/start';

const TOKEN_PATH = '/live/session/token';
const SIGN_OUT_PATH = '/live/signout';
const REFRESH_EARLY_MS = 60_000;

/** The 200 body, checked field by field: anything else is treated as no session. */
function parseToken(
  body: unknown,
): { as: string; team: string; token: string; expiresIn: number } | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  if (typeof b['as'] !== 'string' || b['as'].length === 0) return null;
  if (typeof b['team'] !== 'string' || b['team'].length === 0) return null;
  if (typeof b['access_token'] !== 'string' || !b['access_token'].startsWith('msat_')) return null;
  const expiresIn = b['expires_in'];
  if (typeof expiresIn !== 'number' || !Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return { as: b['as'], team: b['team'], token: b['access_token'], expiresIn };
}

export async function probeHostedSession(
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<HostedSession> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_PATH, { method: 'POST', credentials: 'same-origin' });
  } catch {
    // An unreachable daemon is not a reason to hide the self-hosted sign-in.
    return { kind: 'self_hosted' };
  }
  if (res.status === 404) return { kind: 'self_hosted' };
  if (res.status !== 200) return { kind: 'signed_out' };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'signed_out' };
  }
  const t = parseToken(body);
  if (!t) return { kind: 'signed_out' };
  return {
    kind: 'signed_in',
    as: t.as,
    team: t.team,
    token: t.token,
    expiresAt: now() + t.expiresIn * 1000,
  };
}

/** How long to wait before re-probing: a minute before the token expires, or at once. */
export function refreshDelayMs(s: { expiresAt: number }, now: number): number {
  return Math.max(0, s.expiresAt - now - REFRESH_EARLY_MS);
}

/** End this browser's session on the team (the server revokes it and closes its sockets). */
export async function signOutHosted(fetchImpl: typeof fetch = fetch): Promise<void> {
  await fetchImpl(SIGN_OUT_PATH, { method: 'POST', credentials: 'same-origin' });
}
