import type { IncomingMessage, ServerResponse } from 'node:http';
import { TOKEN_PREFIXES } from '@musterd/protocol';
import { z } from 'zod';
import {
  ConsoleTokenError,
  CONSOLE_UNREACHABLE_SENTENCE,
  jwksFor,
  redeemJti,
  verifyIdentityStatement,
  type IdentityClaims,
} from '../cloud/consoleToken.js';
import { hostTeam } from '../cloud/hostIsolation.js';
import { requestBudgetClient, takeTeamRequest, TEAM_BUDGET_MESSAGE } from '../cloud/teamBudget.js';
import { operatorCtx, teamCtx, type Ctx } from '../context.js';
import { MusterdError, ServiceUnavailable } from '../errors.js';
import { appendAudit } from '../store/audit.js';
import {
  createBrowserSession,
  resolveBrowserSession,
  revokeBrowserSession,
  sessionLabel,
} from '../store/browserSessions.js';
import { checkInvite, consumeInvite, inviteState, type TeamInviteRow } from '../store/invites.js';
import {
  addMember,
  authMember,
  bindMemberAccount,
  getMemberById,
  getMemberByName,
  hashToken,
  memberByAccount,
  setMemberCeiling,
} from '../store/members.js';
import {
  liveSessionClient,
  liveSessionScope,
  mintTokenPair,
  revokeChainsForSession,
} from '../store/oauth.js';
import { issueCode, type OAuthClientSource } from '../store/oauth.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import {
  consumeSigninState,
  startSigninState,
  type SigninStateRow,
} from '../store/signinStates.js';
import { getTeamBySlug } from '../store/teams.js';
import { isCimdClientId } from './cimd.js';
import { connectClientStill, isTlsPeer } from './oauth.js';

/**
 * Hosted `/live` sign-in (ADR 722 §1–4) — the four routes a browser session lives on.
 *
 *   GET|POST /live/signin/start   — write a one-time state, set `__Host-musterd_signin`, go to the console
 *   POST     /live/signin/callback — the console's form POST: state + identity statement → a session
 *   POST     /live/session/token  — the session cookie, same-origin only → `{as, team}` + a 15-minute `msat_`
 *   POST     /live/signout        — the session cookie, same-origin only → revoked
 *
 * Cloud only: a self-hosted daemon answers 404 on all four (ADR 722 §5: self-hosted is untouched).
 * The team is the Host's (`<slug>.<suffix>`), never a path segment. Every refusal leaves no
 * session row and writes one `session.refused` audit row with a reason code — never the secret,
 * the statement, the email or the account id (hard rule 5). The cookie authorizes exactly one
 * route; every other route stays bearer-only, so the public-face Origin skip stays true.
 */

export const LIVE_SESSION_ROUTES = [
  { method: 'GET', path: '/live/signin/start' },
  { method: 'POST', path: '/live/signin/start' },
  { method: 'POST', path: '/live/signin/callback' },
  { method: 'POST', path: '/live/signin/connect' },
  { method: 'POST', path: '/live/session/token' },
  { method: 'POST', path: '/live/signout' },
] as const;

export const SIGNIN_COOKIE = '__Host-musterd_signin';
export const SESSION_COOKIE = '__Host-musterd_s';
/** ADR 722 §3: what the session buys is a 15-minute bearer. */
export const LIVE_ACCESS_TTL_MS = 15 * 60_000;
/** ADR 722 §4: the close code `/live` turns into "You were signed out." */
export const SIGNED_OUT_CLOSE_CODE = 4401;
export const SIGNED_OUT_CLOSE_REASON = 'signed out';

const FORM_MAX_BYTES = 16 * 1024;

export type SessionRefusal =
  | 'origin'
  | 'connect_malformed'
  | 'not_grant'
  | 'client_gone'
  | 'not_same_origin'
  | 'no_cookie'
  | 'state_mismatch'
  | 'state_unknown'
  | 'state_spent'
  | 'state_expired'
  | 'statement'
  | 'unbound'
  | 'not_human'
  | 'member_left'
  | 'already_bound'
  | 'invite_dead'
  | 'name_taken'
  | 'session_unknown'
  | 'session_revoked'
  | 'session_idle'
  | 'session_expired';

/** Where a browser goes for the console's half: its own origin, which publishes the JWKS. */
export function consoleOriginOf(jwksUrl: string): string {
  return new URL(jwksUrl).origin;
}

export function teamOriginOf(slug: string, hostSuffix: string): string {
  return `https://${slug}.${hostSuffix}`;
}

export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    if (!out.has(k)) out.set(k, part.slice(i + 1).trim());
  }
  return out;
}

/**
 * The two cookies, exactly as ADR 722 says. `__Host-` makes a browser refuse either one without
 * Secure and Path=/ or with a Domain, so those three are not optional. The signin cookie is
 * SameSite=None because it must ride the console's cross-site form POST; the session cookie is Lax.
 */
export function signinCookie(state: string, maxAgeS = 600): string {
  return `${SIGNIN_COOKIE}=${state}; Max-Age=${maxAgeS}; Path=/; Secure; HttpOnly; SameSite=None`;
}
export function sessionCookie(secret: string, maxAgeS: number): string {
  return `${SESSION_COOKIE}=${secret}; Max-Age=${maxAgeS}; Path=/; Secure; HttpOnly; SameSite=Lax`;
}
const CLEAR_SIGNIN = signinCookie('', 0);
const CLEAR_SESSION = sessionCookie('', 0);

const InviteStartSchema = z.object({
  invite: z.string().min(1).max(512),
  name: z.string().min(1).max(64),
});
const LinkStartSchema = z.object({ mode: z.literal('link') });
const CallbackSchema = z.object({
  state: z.string().min(1).max(256),
  statement: z.string().min(1).max(8192),
});

/** Route a request if it is one of the four; false lets the caller carry on. */
export async function handleLiveSessionRoutes(
  rootCtx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  if (!LIVE_SESSION_ROUTES.some((r) => r.method === method && r.path === path)) return false;
  const cloud = rootCtx.config.cloud;
  if (!cloud) throw new MusterdError('not_found', 'not found');
  if (!isTlsPeer(rootCtx, req))
    throw new MusterdError('forbidden', 'browser sign-in is refused over plaintext');
  const slug = hostTeam(req.headers.host, cloud.hostSuffix);
  // These paths name no team, so the path-team budget never charged them (ADR 634): charge the
  // host's team here, before any store write — a start writes a row, and it is unauthenticated.
  if (
    slug &&
    !takeTeamRequest(
      slug,
      requestBudgetClient(req, rootCtx.config.trustProxy),
      cloud.teamBudgetPerMin,
    )
  ) {
    res.setHeader('retry-after', '60');
    throw new MusterdError('rate_limited', TEAM_BUDGET_MESSAGE);
  }
  const team = slug ? await getTeamBySlug(operatorCtx(rootCtx).db, slug) : undefined;
  if (!team) throw new MusterdError('not_found', 'not found');
  const env = envFor(rootCtx, team, cloud);
  if (path === '/live/signin/start') await start(env, req, res, method, url);
  else if (path === '/live/signin/callback') await callback(env, req, res);
  else if (path === '/live/signin/connect') await confirmConnect(env, req, res);
  else if (path === '/live/session/token') await exchange(env, req, res);
  else await signout(env, req, res);
  return true;
}

function envFor(rootCtx: Ctx, team: TeamRow, cloud: NonNullable<Ctx['config']['cloud']>): Env {
  return {
    ctx: teamCtx(rootCtx, team.id),
    rootCtx,
    team,
    consoleOrigin: consoleOriginOf(cloud.consoleJwksUrl),
    teamOrigin: teamOriginOf(team.slug, cloud.hostSuffix),
    jwksUrl: cloud.consoleJwksUrl,
    audience: cloud.consoleAudience,
  };
}

interface Env {
  ctx: Ctx;
  rootCtx: Ctx;
  team: TeamRow;
  consoleOrigin: string;
  teamOrigin: string;
  jwksUrl: string;
  audience: string;
}

// ── connect (ADR 820) ───────────────────────────────────────────────────────────────────────────

/** ADR 820: the authorization request a `connect` state carries, plus the client's source. */
const ConnectRequestSchema = z
  .object({
    client_id: z.string().min(1),
    redirect_uri: z.string().min(1),
    code_challenge: z.string().min(1),
    state: z.string().min(1),
    scope: z.string().optional(),
    client_source: z.enum(['dcr', 'cimd']),
  })
  .strict();
export type ConnectStart = z.infer<typeof ConnectRequestSchema>;

/**
 * ADR 820: whether this request reached a hosted team on its own origin over TLS — the only place
 * "Sign in with musterd" can finish, because the round trip comes back to that origin's callback.
 */
export function connectAvailable(ctx: Ctx, req: IncomingMessage, slug: string): boolean {
  const cloud = ctx.config.cloud;
  return !!cloud && isTlsPeer(ctx, req) && hostTeam(req.headers.host, cloud.hostSuffix) === slug;
}

/**
 * ADR 820 §2: start the console round trip for one MCP client authorization the consent POST has
 * already validated. Answers the console URL and the signin cookie; the caller sends the 303.
 */
export async function beginConnectSignin(
  rootCtx: Ctx,
  team: TeamRow,
  request: ConnectStart,
): Promise<{ location: string; cookie: string }> {
  const cloud = rootCtx.config.cloud;
  if (!cloud) throw new MusterdError('not_found', 'not found');
  const ctx = teamCtx(rootCtx, team.id);
  const s = await startSigninState(ctx.db, {
    teamId: team.id,
    mode: 'connect',
    oauthRequest: ConnectRequestSchema.parse(request),
  });
  const env = envFor(rootCtx, team, cloud);
  return { location: handbackUrl(env, s.state), cookie: signinCookie(s.state) };
}

/** The client, if authorize would still accept it with this redirect (ADR 820, ADR 470, ADR 743). */
function clientStill(env: Env, request: ConnectStart): Promise<{ client_name: string } | null> {
  return connectClientStill(env.ctx.db, env.team.id, request.client_id, request.redirect_uri);
}

const parseConnect = (raw: string | null): ConnectStart | null => {
  try {
    return ConnectRequestSchema.parse(JSON.parse(raw ?? ''));
  } catch {
    return null;
  }
};

/**
 * ADR 820 §3: the callback's end for a `connect` state. Nothing is issued yet: the console may
 * have signed with whatever account was already signed in there, so the person is shown who they
 * are about to connect as, and the code waits for their Allow on a one-time `grant` state.
 */
async function connectBack(
  env: Env,
  res: ServerResponse,
  record: SigninStateRow,
  member: MemberRow,
  refuse: (reason: SessionRefusal) => Promise<void>,
): Promise<void> {
  const { ctx, team } = env;
  const request = parseConnect(record.oauth_request);
  if (!request) return refuse('connect_malformed');
  const client = await clientStill(env, request);
  if (!client) return refuse('client_gone');
  const grant = await startSigninState(ctx.db, {
    teamId: team.id,
    mode: 'grant',
    memberId: member.id,
    oauthRequest: request,
  });
  confirmPage(res, {
    client: client.client_name,
    team: team.slug,
    member: member.name,
    state: grant.state,
    cookie: signinCookie(grant.state),
  });
}

/**
 * ADR 820 §3: the person's Allow or Cancel. Same-origin only (the confirm page is the only form
 * that may post here); the cookie, the form and an unspent `grant` state must agree. The request
 * comes from the grant, never from the form, so no field can swap the client or the redirect.
 */
async function confirmConnect(env: Env, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { ctx, team } = env;
  const refuse = async (reason: SessionRefusal): Promise<void> => {
    await refusedRow(ctx.db, team.id, reason);
    page(res, 403, "That didn't complete. Start again from the app you were connecting.", [
      CLEAR_SIGNIN,
    ]);
  };
  if (req.headers['sec-fetch-site'] !== 'same-origin') return refuse('not_same_origin');
  const cookieState = parseCookies(req.headers.cookie).get(SIGNIN_COOKIE);
  const form = ConfirmSchema.safeParse(await readForm(req));
  if (!cookieState) return refuse('no_cookie');
  if (!form.success || form.data.state !== cookieState) return refuse('state_mismatch');
  const consumed = await consumeSigninState(ctx.db, team.id, form.data.state);
  if (!consumed.ok) return refuse(`state_${consumed.reason}`);
  if (consumed.record.mode !== 'grant') return refuse('not_grant');
  const request = parseConnect(consumed.record.oauth_request);
  if (!request) return refuse('connect_malformed');
  const back = (query: string): void => {
    const sep = request.redirect_uri.includes('?') ? '&' : '?';
    res.writeHead(302, {
      location: `${request.redirect_uri}${sep}${query}&state=${encodeURIComponent(request.state)}`,
      'cache-control': 'no-store',
      pragma: 'no-cache',
      'set-cookie': CLEAR_SIGNIN,
      'content-length': '0',
    });
    res.end();
  };
  if (form.data.decision === 'deny') return back('error=access_denied');
  // Re-checked at the click, not trusted from the callback a minute ago.
  const member = consumed.record.member_id
    ? await getMemberById(ctx.db, consumed.record.member_id)
    : undefined;
  if (!member || member.left_at !== null || member.team_id !== team.id || member.kind !== 'human')
    return refuse('member_left');
  if (!(await clientStill(env, request))) return refuse('client_gone');
  const { code } = await issueCode(ctx.db, {
    teamId: team.id,
    memberId: member.id,
    clientId: request.client_id,
    clientSource: request.client_source as OAuthClientSource,
    redirectUri: request.redirect_uri,
    codeChallenge: request.code_challenge,
    ...(request.scope ? { scope: request.scope } : {}),
  });
  await appendAudit(ctx.db, team.id, {
    actor: member.name,
    action: 'oauth.code_issued',
    target: isCimdClientId(request.client_id) ? null : request.client_id,
    result: 'allow',
    detail: { via: 'musterd' },
  });
  back(`code=${encodeURIComponent(code)}`);
}

const ConfirmSchema = z.object({
  state: z.string().min(1).max(256),
  decision: z.enum(['allow', 'deny']),
});

/**
 * The confirm page. Never framed (the Allow button is a clickjacking target), no script, and no
 * `form-action`: a browser applies it to the 302 the POST answers, which goes to the client.
 */
function confirmPage(
  res: ServerResponse,
  o: { client: string; team: string; member: string; state: string; cookie: string },
): void {
  const e = (v: string) => v.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect ${e(o.client)} to ${e(o.team)} — musterd</title></head>
<body style="font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem;line-height:1.5">
<h1 style="font-size:1.375rem;margin:0 0 .5rem">Connect ${e(o.client)} to ${e(o.team)}?</h1>
<p style="margin:0 0 1.5rem">As <strong>${e(o.member)}</strong>. ${e(o.client)} will be able to read the team and send as you until you sign it out.</p>
<form method="post" action="/live/signin/connect" style="display:flex;gap:.75rem">
<input type="hidden" name="state" value="${e(o.state)}">
<button type="submit" name="decision" value="allow" style="min-height:2.75rem;padding:0 1.25rem;font:inherit;font-weight:600;border-radius:8px;border:1px solid #e1ad01;background:#e1ad01;color:#18181b">Allow</button>
<button type="submit" name="decision" value="deny" style="min-height:2.75rem;padding:0 1.25rem;font:inherit;border-radius:8px;border:1px solid #71717a;background:#fff;color:#18181b">Cancel</button>
</form></body></html>`;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy':
      "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'set-cookie': [o.cookie],
  });
  res.end(body);
}

// ── start ───────────────────────────────────────────────────────────────────────────────────────

async function start(
  env: Env,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  url: URL,
): Promise<void> {
  const { ctx, team } = env;
  if (method === 'POST') {
    // Link (§2): the member proves themselves with their `mscr_` bearer; the state pins them.
    const body = LinkStartSchema.safeParse(await readJsonBody(req));
    if (!body.success) throw new MusterdError('bad_request', 'expected {"mode":"link"}');
    const auth = await authMember(ctx.db, team.slug, bearerOf(req));
    if (auth.member.kind !== 'human')
      throw new MusterdError('forbidden', 'only a human member links a musterd account');
    const s = await startSigninState(ctx.db, {
      teamId: team.id,
      mode: 'link',
      memberId: auth.member.id,
    });
    res.writeHead(200, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'set-cookie': signinCookie(s.state),
    });
    res.end(JSON.stringify({ url: handbackUrl(env, s.state) }));
    return;
  }

  // GET: a plain sign-in, or a stranger arriving on an invite link (§2, ADR 450).
  const invite = url.searchParams.get('invite');
  let s: { state: string };
  if (invite !== null) {
    const parsed = InviteStartSchema.safeParse({
      invite,
      name: url.searchParams.get('name') ?? '',
    });
    if (!parsed.success) return page(res, 400, 'An invite needs a name to join as.');
    const outcome = await ctx.db.tx(async (t) => {
      const check = await checkInvite(t, team.id, parsed.data.invite);
      if (!check.ok) {
        await refusedRow(t, team.id, 'invite_dead', { via: check.via, charged: check.charged });
        return { err: 'invite' as const };
      }
      if (await getMemberByName(t, team.id, parsed.data.name)) return { err: 'name' as const };
      return { inviteId: check.invite.id };
    });
    if ('err' in outcome)
      return page(
        res,
        outcome.err === 'invite' ? 403 : 409,
        outcome.err === 'invite'
          ? "That invite isn't valid for this team."
          : 'That name is taken — pick another.',
      );
    s = await startSigninState(ctx.db, {
      teamId: team.id,
      mode: 'invite',
      inviteId: outcome.inviteId,
      name: parsed.data.name,
    });
  } else {
    s = await startSigninState(ctx.db, { teamId: team.id, mode: 'signin' });
  }
  res.writeHead(303, {
    location: handbackUrl(env, s.state),
    'cache-control': 'no-store',
    'set-cookie': signinCookie(s.state),
    'content-length': '0',
  });
  res.end();
}

function handbackUrl(env: Env, state: string): string {
  const u = new URL('/handback', env.consoleOrigin);
  u.searchParams.set('aud', env.audience);
  u.searchParams.set('team', env.team.slug);
  u.searchParams.set('state', state);
  return u.toString();
}

// ── callback ────────────────────────────────────────────────────────────────────────────────────

async function callback(env: Env, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { ctx, team } = env;
  // The signin cookie is cleared on every answer: it worked once or it is dead.
  const refuse = async (reason: SessionRefusal, status = 403): Promise<void> => {
    await refusedRow(ctx.db, team.id, reason);
    const sentence =
      reason === 'unbound'
        ? "This musterd account isn't on this team yet. Ask an owner for an invite."
        : "That sign-in didn't complete. Start again from /live.";
    page(res, status, sentence, [CLEAR_SIGNIN]);
  };

  if (req.headers.origin !== env.consoleOrigin) return refuse('origin');
  const cookieState = parseCookies(req.headers.cookie).get(SIGNIN_COOKIE);
  const form = CallbackSchema.safeParse(await readForm(req));
  if (!cookieState) return refuse('no_cookie');
  if (!form.success || form.data.state !== cookieState) return refuse('state_mismatch');
  const consumed = await consumeSigninState(ctx.db, team.id, form.data.state);
  if (!consumed.ok) return refuse(`state_${consumed.reason}`);

  let claims: IdentityClaims;
  try {
    claims = await verifyIdentityStatement(form.data.statement, {
      jwks: jwksFor(env.jwksUrl),
      audience: env.audience,
    });
    // Single use across every server: the jti table is global, so the operator handle redeems it.
    await redeemJti(operatorCtx(env.rootCtx).db, claims.jti, claims.exp);
  } catch (e) {
    if (e instanceof ConsoleTokenError && e.reason === 'console_unreachable')
      throw new ServiceUnavailable(CONSOLE_UNREACHABLE_SENTENCE);
    if (e instanceof ConsoleTokenError) {
      await refusedRow(ctx.db, team.id, 'statement', { why: e.reason });
      return page(res, 403, "That sign-in didn't complete. Start again from /live.", [
        CLEAR_SIGNIN,
      ]);
    }
    throw e;
  }

  const bound = await memberFor(env, consumed.record, claims.accountId);
  if ('refusal' in bound) return refuse(bound.refusal);
  // ADR 820: a connector's round trip ends in a code for its client, never in a browser session.
  if (consumed.record.mode === 'connect')
    return connectBack(env, res, consumed.record, bound.member, refuse);

  const session = await createBrowserSession(ctx.db, {
    teamId: team.id,
    memberId: bound.member.id,
    label: sessionLabel(req.headers['user-agent']),
  });
  await appendAudit(ctx.db, team.id, {
    actor: bound.member.name,
    action: 'session.created',
    target: session.id,
    result: 'allow',
    detail: { session_id: session.id, mode: consumed.record.mode },
  });
  res.writeHead(303, {
    location: '/live',
    'cache-control': 'no-store',
    'set-cookie': [
      CLEAR_SIGNIN,
      sessionCookie(session.secret, Math.floor((session.expires_at - Date.now()) / 1000)),
    ],
    'content-length': '0',
  });
  res.end();
}

/** Which member this account signs in as, binding it the one way the state record allows. */
async function memberFor(
  env: Env,
  record: SigninStateRow,
  accountId: string,
): Promise<{ member: MemberRow } | { refusal: SessionRefusal }> {
  const { ctx, team } = env;
  if (record.mode === 'link') {
    const member = record.member_id ? await getMemberById(ctx.db, record.member_id) : undefined;
    if (!member || member.left_at !== null || member.team_id !== team.id)
      return { refusal: 'member_left' };
    if (member.kind !== 'human') return { refusal: 'not_human' };
    try {
      await bindMemberAccount(ctx.db, member.id, accountId);
    } catch (e) {
      if (e instanceof MusterdError && e.code === 'conflict') return { refusal: 'already_bound' };
      throw e;
    }
    return { member: (await getMemberById(ctx.db, member.id))! };
  }
  if (record.mode === 'invite') return await admitByInvite(env, record, accountId);
  const member = await memberByAccount(ctx.db, team.id, accountId);
  if (!member) return { refusal: 'unbound' };
  if (member.kind !== 'human') return { refusal: 'not_human' };
  return { member };
}

/** ADR 450 through the console: the invite checked at start, re-checked and spent here. */
async function admitByInvite(
  env: Env,
  record: SigninStateRow,
  accountId: string,
): Promise<{ member: MemberRow } | { refusal: SessionRefusal }> {
  const { ctx, team } = env;
  // An account already on the team signs in as itself; an invite never makes it a second member.
  const existing = await memberByAccount(ctx.db, team.id, accountId);
  if (existing) return existing.kind === 'human' ? { member: existing } : { refusal: 'not_human' };
  return await ctx.db.tx(async (t) => {
    const invite = await t.get<TeamInviteRow>(
      'SELECT * FROM team_invites WHERE team_id = ? AND id = ? AND revoked_at IS NULL',
      [team.id, record.invite_id ?? ''],
    );
    if (!invite || inviteState(invite) !== 'live') return { refusal: 'invite_dead' as const };
    const name = record.name ?? '';
    if (!name || (await getMemberByName(t, team.id, name)))
      return { refusal: 'name_taken' as const };
    const added = await addMember(t, team, {
      name,
      kind: 'human',
      ...(invite.member_until !== null
        ? { lifecycle: 'until' as const, lifecycleUntil: invite.member_until }
        : {}),
    });
    // `added.token` (the member's mscr_) is dropped on purpose: a hosted member never pastes one.
    const ceiling = invite.ceiling ?? null;
    if (ceiling !== null) await setMemberCeiling(t, added.row.id, ceiling);
    await consumeInvite(t, invite.id);
    await bindMemberAccount(t, added.row.id, accountId);
    await appendAudit(t, team.id, {
      actor: added.row.name,
      action: 'member.invite_admitted',
      target: invite.id,
      result: 'allow',
      detail: { via: 'console', ceiling },
    });
    return { member: (await getMemberById(t, added.row.id))! };
  });
}

// ── token exchange + signout ────────────────────────────────────────────────────────────────────

/** ADR 722 §3: exactly the team's own page, from a same-origin fetch. */
function sameOriginRefusal(env: Env, req: IncomingMessage): SessionRefusal | null {
  if (req.headers.origin !== env.teamOrigin) return 'origin';
  if (req.headers['sec-fetch-site'] !== 'same-origin') return 'not_same_origin';
  return null;
}

async function exchange(env: Env, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { ctx, team } = env;
  const deny = async (reason: SessionRefusal): Promise<void> => {
    await refusedRow(ctx.db, team.id, reason);
    sendJsonNoStore(res, 401, {
      error: { code: 'unauthorized', message: 'no browser session — sign in again' },
    });
  };
  const origin = sameOriginRefusal(env, req);
  if (origin) return deny(origin);
  const secret = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  if (!secret) return deny('no_cookie');
  const resolved = await resolveBrowserSession(ctx.db, team.id, secret);
  if (!resolved.ok) return deny(`session_${resolved.reason}`);
  const member = await getMemberById(ctx.db, resolved.session.member_id);
  if (!member || member.left_at !== null || member.kind !== 'human') return deny('member_left');
  const pair = await mintTokenPair(ctx.db, {
    teamId: team.id,
    memberId: member.id,
    clientId: await liveSessionClient(ctx.db, team.id),
    scope: liveSessionScope(resolved.session.id),
    accessTtlMs: LIVE_ACCESS_TTL_MS,
  });
  // The refresh half is never handed out on this path; it dies with the session's revoke.
  sendJsonNoStore(res, 200, {
    as: member.name,
    // The callback lands on a bare `/live`; this is how the page learns which team it is on.
    team: team.slug,
    access_token: pair.access_token,
    expires_in: pair.expires_in,
  });
}

async function signout(env: Env, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { ctx, team } = env;
  const origin = sameOriginRefusal(env, req);
  if (origin) {
    await refusedRow(ctx.db, team.id, origin);
    return sendJsonNoStore(res, 403, {
      error: { code: 'forbidden', message: 'sign out from this team’s own page' },
    });
  }
  const secret = parseCookies(req.headers.cookie).get(SESSION_COOKIE);
  if (secret?.startsWith('mbs_')) {
    const row = await ctx.db.get<{ id: string; member_id: string }>(
      'SELECT id, member_id FROM browser_sessions WHERE team_id = ? AND secret_hash = ? AND revoked_at IS NULL',
      [team.id, hashToken(secret)],
    );
    if (row && (await revokeBrowserSession(ctx.db, team.id, row.id))) {
      const member = await getMemberById(ctx.db, row.member_id);
      await endSessions(ctx, team, [row.id], { by: 'self', actor: member?.name ?? null, member });
    }
  }
  res.writeHead(204, { 'set-cookie': CLEAR_SESSION, 'cache-control': 'no-store' });
  res.end();
}

/**
 * What every revoke shares once the rows are revoked (ADR 722 §4): the sessions' token chains die,
 * their open sockets close with the stable reason, and each leaves a `session.revoked` row.
 */
export async function endSessions(
  ctx: Ctx,
  team: TeamRow,
  sessionIds: string[],
  who: { by: 'self' | 'admin' | 'rotate'; actor: string | null; member?: MemberRow | undefined },
): Promise<void> {
  for (const id of sessionIds) {
    await revokeChainsForSession(ctx.db, team.id, id);
    ctx.hub.closeSession(id, SIGNED_OUT_CLOSE_CODE, SIGNED_OUT_CLOSE_REASON);
    await appendAudit(ctx.db, team.id, {
      actor: who.actor,
      action: 'session.revoked',
      target: who.member?.name ?? null,
      result: 'allow',
      detail: { session_id: id, by: who.by },
    });
  }
}

// ── small helpers ───────────────────────────────────────────────────────────────────────────────

async function refusedRow(
  db: Ctx['db'],
  teamId: string,
  reason: SessionRefusal,
  extra: Record<string, unknown> = {},
): Promise<void> {
  await appendAudit(db, teamId, {
    actor: null,
    action: 'session.refused',
    target: null,
    result: 'deny',
    detail: { reason, ...extra },
  });
}

function bearerOf(req: IncomingMessage): string {
  const h = req.headers['authorization'];
  if (!h || !h.startsWith('Bearer '))
    throw new MusterdError('unauthorized', 'linking needs your member credential as a bearer');
  const token = h.slice('Bearer '.length).trim();
  if (!token.startsWith(TOKEN_PREFIXES.credential))
    throw new MusterdError('unauthorized', 'linking needs your member credential (mscr_)');
  return token;
}

async function readRaw(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > FORM_MAX_BYTES)
      throw new MusterdError('payload_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function readForm(req: IncomingMessage): Promise<Record<string, string>> {
  const ctype = req.headers['content-type']?.split(';')[0]?.trim().toLowerCase();
  const raw = await readRaw(req);
  if (ctype !== 'application/x-www-form-urlencoded') return {};
  return Object.fromEntries(new URLSearchParams(raw));
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const raw = await readRaw(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new MusterdError('bad_request', 'invalid JSON body');
  }
}

function sendJsonNoStore(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(payload)),
  });
  res.end(payload);
}

/** One sentence on a plain page. Never names a member, an account or an email. */
function page(res: ServerResponse, status: number, sentence: string, cookies: string[] = []): void {
  const esc = sentence.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign in — musterd</title>
<meta name="viewport" content="width=device-width, initial-scale=1"></head>
<body style="font-family:system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem">
<p>${esc}</p><p><a href="/live">Back to musterd</a></p></body></html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    ...(cookies.length ? { 'set-cookie': cookies } : {}),
  });
  res.end(body);
}
