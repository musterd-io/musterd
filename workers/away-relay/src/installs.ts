/**
 * The distributed Slack app's install flow (ADR 668 decision 2, increment 9) — the pure
 * half: the OAuth authorize URL, the `oauth.v2.access` response shape, and the install
 * state rule. No I/O lives here, so every rule is testable in plain vitest.
 *
 * The flow replaces the operator-set `SLACK_TEAM_MAP_JSON` with an install record written
 * only by this flow: a daemon mints a one-time state, the workspace installer authorizes
 * at Slack, Slack returns here with a code, the code is exchanged with the app's client
 * secret (a Worker secret, set by the operator), and the resulting mapping
 * (Slack team → musterd team → destination) plus the per-install bot token are recorded.
 * Nothing in an incoming callback can write or alter that mapping.
 */

/** The scopes the distributed app requests at install (app review lists exactly these). */
export const SLACK_INSTALL_SCOPES = ['chat:write', 'im:write', 'users:read'];

export function slackAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('scope', SLACK_INSTALL_SCOPES.join(','));
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('state', input.state);
  return url.href;
}

export interface SlackInstallRecord {
  slackTeamId: string;
  botToken: string;
  installerSlackId: string;
}

/**
 * Slack's `oauth.v2.access` answer, parsed at the boundary: the workspace's team id, the
 * per-install bot token, and the installer's Slack user id. Anything else — an error
 * answer, a missing token, a missing team — is no install at all.
 */
export function parseSlackOAuthResponse(v: unknown): SlackInstallRecord | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  if (r['ok'] !== true) return null;
  const token = r['access_token'];
  const team = r['team'];
  const authed = r['authed_user'];
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof team !== 'object' || team === null || Array.isArray(team)) return null;
  const teamId = (team as Record<string, unknown>)['id'];
  if (typeof teamId !== 'string' || teamId.length === 0) return null;
  const installer =
    typeof authed === 'object' && authed !== null && !Array.isArray(authed)
      ? (authed as Record<string, unknown>)['id']
      : null;
  if (typeof installer !== 'string' || installer.length === 0) return null;
  return { slackTeamId: teamId, botToken: token, installerSlackId: installer };
}

/**
 * A Cloud destination for one install (spec: Slack ingress §3): the hosted team's
 * server base, as an https origin. Anything else — http, a path, a userinfo trick —
 * is no destination, and the install falls back to the relay-object transport.
 */
export function cloudDestinationFrom(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  try {
    const url = new URL(v);
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (url.pathname !== '/' && url.pathname !== '') return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** The ingress attestation payload (spec §3): `<timestamp>.<raw body>`, Ed25519. */
export function ingressSignedPayload(timestamp: string, rawBody: string): string {
  return `${timestamp}.${rawBody}`;
}

/** An install state lives ten minutes and is consumed by the first completed exchange. */
export const INSTALL_STATE_TTL_MS = 10 * 60 * 1000;

export function installStateLive(
  createdAt: number,
  consumedAt: number | null,
  now: number,
): boolean {
  return consumedAt === null && createdAt > 0 && now - createdAt <= INSTALL_STATE_TTL_MS;
}
