import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { accountFor, methodsOf } from './accounts.js';
import { appendAudit } from './audit.js';
import { clientIp, type ClientIpOptions } from './clientip.js';
import type { ConsoleConfig } from './config.js';
import { hostCookie } from './cookies.js';
import { csrfTokenFor, csrfTokenValid, originAllowed } from './csrf.js';
import { DATABASE_UNREACHABLE_SENTENCE, type Queryable } from './db.js';
import { sendSignInEmail } from './email.js';
import type { Log } from './log.js';
import {
  accountPage,
  assetFor,
  checkEmailPage,
  errorPages,
  finishPage,
  PAGE_CSP,
  signInPage,
  wrongBrowserPage,
} from './pages.js';
import {
  finishFlow,
  PROVIDERS,
  startFlow,
  type ProviderId,
  type ProviderOverrides,
} from './providers.js';
import { hit } from './ratelimit.js';
import { cookie, FormError, readForm, SESSION_COOKIE } from './request.js';
import { safeReturnPath } from './returnpath.js';
import { hashSecret, newSecret } from './secrets.js';
import { ABSOLUTE_MS, createSession, loadSession, revokeSession } from './sessions.js';
import {
  consumeMagic,
  consumeOAuthTx,
  createMagicTx,
  createOAuthTx,
  lookupMagic,
  MAGIC_TTL_MS,
  TX_COOKIE,
  TX_TTL_MS,
} from './transactions.js';

/**
 * The console's HTTP boundary (ADR 615). It serves `GET /health` and
 * `GET /.well-known/jwks.json` (an empty key set), the ADR 620 sign-in flows, and the sign-in
 * screens those flows render (pages.ts) — and refuses everything else. No signing, identity
 * binding or team provisioning route exists until its own lane, and there is no development
 * issuer or test key to fall back to: an empty JWKS authenticates no one.
 *
 * What the boundary holds from day one (big-body's security read, 2026-10-15):
 * - Host: answered only on the configured hosts; anything else is 404 (never a hint which exist).
 * - Forwarded headers: not read. No route here uses the client address, so none is trusted.
 * - Methods: GET and HEAD only; a body is never read. Header size and request/header timeouts are
 *   bounded on the server itself.
 * - Request id: an inbound `x-request-id` is kept only if it is a short safe token, else replaced.
 * - Headers: HSTS, nosniff, no referrer, a `default-src 'none'` CSP, frame-ancestors none.
 * - Errors: one shape, `{ error: { code, message } }`, with stable messages — never a URL, a stack
 *   or a driver error. `/health` answers `{ ok, build }` or one fixed sentence.
 * - Logs: one line per request with id, method, route label, status and ms — never the raw path,
 *   query, headers or body.
 */
export const MAX_HEADER_BYTES = 16 * 1024;
export const REQUEST_TIMEOUT_MS = 10_000;
export const HEADERS_TIMEOUT_MS = 5_000;
const REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

const SECURITY_HEADERS: Record<string, string> = {
  'strict-transport-security': 'max-age=63072000; includeSubDomains',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  'x-frame-options': 'DENY',
  'cross-origin-opener-policy': 'same-origin',
};

export interface ConsoleDeps {
  config: ConsoleConfig;
  db: Queryable;
  log: Log;
  /** The clock (tests hold it). */
  now?: () => number;
  /** Tests only: fake provider endpoints. */
  providers?: ProviderOverrides;
  /** Which hops' forwarded headers are believed (default: on Fly, Cloudflare's ranges). */
  clientIp?: ClientIpOptions;
  /** Tests only: the email transport (default: Cloudflare Email Service over fetch). */
  sendEmail?: typeof sendSignInEmail;
}

/** Routes that change state, and the only paths a POST may reach (ADR 620 decision 8). */
const POST_ROUTES = new Set([
  '/logout',
  '/auth/github/start',
  '/auth/google/start',
  '/auth/email/start',
  '/auth/email/confirm',
]);
/**
 * Magic-link limits (ADR 620 decisions 6 and 9). None of them is global, because a global limit
 * is a switch any one client can flip for everyone (security review, 2026-10-16):
 * - per client: 5 an hour, whatever the addresses;
 * - per address AND client: 5 an hour, so one client cannot bomb an inbox;
 * - per address across all clients: 20 an hour, which bounds a distributed bombing. This is the
 *   one limit an attacker can aim at someone: twenty sends an hour, sustained, delays email
 *   sign-in for that one address. Its other sign-in methods are untouched. Recorded in ADR 620.
 * The send count is watched, not enforced: past EMAIL_SEND_WATCH an hour the console logs a
 * warning for a human, and Cloudflare's own sending quota is the cost backstop.
 */
const EMAIL_PER_CLIENT = 5;
const EMAIL_PER_ADDRESS_CLIENT = 5;
const EMAIL_PER_ADDRESS = 20;
const EMAIL_WINDOW_MS = 60 * 60 * 1000;
const EMAIL_SEND_WATCH = 2000;

/**
 * The inbox an address reaches, for COUNTING only — never for identity (ADR 620 decision 3 keeps
 * the identity exactly as typed). Mail systems deliver `Nick@`, `NICK@`, `nick+anything@` and, at
 * Gmail, `n.i.c.k@` to one inbox, so a limit keyed on the typed address let each variant start a
 * fresh bucket and bomb the same inbox (security review, 2026-10-16). Case-folded, `+tag` dropped,
 * and Gmail's dots removed.
 */
export function inboxKey(address: string): string {
  const at = address.lastIndexOf('@');
  let local = address.slice(0, at).toLowerCase();
  const domain = address.slice(at + 1).toLowerCase();
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') local = local.replace(/\./g, '');
  return `${local}@${domain === 'googlemail.com' ? 'gmail.com' : domain}`;
}

/**
 * An address we will send to: trimmed, at most 254 characters, one `@`, a dotted domain, no
 * whitespace or control characters. The domain is lowercased; the local part is kept exactly
 * (ADR 620 decision 3: no plus-alias collapsing, no dot removal).
 */
function emailAddress(input: string | null): string | null {
  const v = (input ?? '').trim();
  if (
    v.length < 3 ||
    v.length > 254 ||
    /[\s<>"]/.test(v) ||
    [...v].some((c) => c.charCodeAt(0) < 0x20)
  )
    return null;
  const at = v.lastIndexOf('@');
  if (at < 1 || v.indexOf('@') !== at) return null;
  const domain = v.slice(at + 1).toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(domain))
    return null;
  return `${v.slice(0, at)}@${domain}`;
}
const START = /^\/auth\/(github|google)\/start$/;
const CALLBACK = /^\/auth\/(github|google)\/callback$/;
/**
 * Sign-in rate limits are per client, never global (ADR 620 decision 9: no limit an attacker can
 * use to keep someone else out). A single global bucket let one client spend the whole budget and
 * lock every person out of sign-in (security review of #2725, 2026-10-16).
 */
const START_PER_CLIENT = 30;
const CALLBACK_PER_CLIENT = 30;
const WINDOW_MS = 60_000;

function txCookie(value: string, maxAgeSeconds: number): string {
  return hostCookie('tx', value, maxAgeSeconds);
}

function hostOf(req: IncomingMessage): string | null {
  const h = req.headers.host;
  if (!h || h.startsWith('[')) return null;
  return h.replace(/:\d+$/, '').toLowerCase();
}

function allowedHost(req: IncomingMessage, allowed: string[]): boolean {
  const raw = req.headers.host?.toLowerCase();
  const bare = hostOf(req);
  return raw !== undefined && (allowed.includes(raw) || (bare !== null && allowed.includes(bare)));
}

function send(
  res: ServerResponse,
  status: number,
  body: unknown,
  extra: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(res.req.method === 'HEAD' ? undefined : payload);
}

const err = (code: string, message: string) => ({ error: { code, message } });

function sendHtml(
  res: ServerResponse,
  status: number,
  html: string,
  extra: Record<string, string | string[]> = {},
): void {
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-security-policy': PAGE_CSP,
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    ...extra,
  });
  res.end(res.req.method === 'HEAD' ? undefined : html);
}

export function createConsoleServer(deps: ConsoleDeps): Server {
  const { config, db, log } = deps;
  const now = deps.now ?? Date.now;
  const ipOptions: ClientIpOptions = deps.clientIp ?? {
    behindFlyProxy: Boolean(process.env['FLY_APP_NAME']),
  };
  const clientKey = (req: IncomingMessage) => clientIp(req, ipOptions);
  const server = createServer(
    { maxHeaderSize: MAX_HEADER_BYTES, requestTimeout: REQUEST_TIMEOUT_MS },
    (req, res) => {
      const started = Date.now();
      const inbound = req.headers['x-request-id'];
      const rid = typeof inbound === 'string' && REQUEST_ID.test(inbound) ? inbound : randomUUID();
      res.setHeader('x-request-id', rid);
      let route = 'unmatched';
      res.on('finish', () =>
        log.info('http_request', {
          rid,
          method: req.method ?? '?',
          route,
          status: res.statusCode,
          ms: Date.now() - started,
        }),
      );
      void (async () => {
        try {
          if (!allowedHost(req, config.allowedHosts))
            return send(res, 404, err('not_found', 'not found'));
          const path = (req.url ?? '/').split('?')[0] ?? '/';
          if (req.method === 'POST' && POST_ROUTES.has(path)) {
            // Every state change: the exact Origin, then the body's type and size, then the
            // session's CSRF token (ADR 620 decision 8). A GET never reaches this branch.
            if (!originAllowed(req, config.issuer)) {
              route = 'forbidden_origin';
              return send(res, 403, err('forbidden', 'forbidden'));
            }
            let form: URLSearchParams;
            try {
              form = await readForm(req);
            } catch (e) {
              if (e instanceof FormError)
                return send(res, e.status, err(e.code, e.code.replace(/_/g, ' ')));
              throw e;
            }
            const start = START.exec(path);
            if (start) {
              const p = start[1] as ProviderId;
              route = `auth_start_${p}`;
              const creds = config.providers[p];
              if (!creds) return send(res, 404, err('not_found', 'not found'));
              const t = now();
              if (
                !(await hit(
                  db,
                  { bucket: `start:${clientKey(req)}`, max: START_PER_CLIENT, windowMs: WINDOW_MS },
                  t,
                ))
              )
                return sendHtml(res, 429, errorPages.rate(), { 'retry-after': '60' });
              const flow = await startFlow(p, creds, config.issuer, deps.providers);
              const txValue = await createOAuthTx(
                db,
                {
                  provider: p,
                  state: flow.state,
                  pkceVerifier: flow.pkceVerifier,
                  nonce: flow.nonce,
                  returnPath: safeReturnPath(form.get('return')),
                },
                t,
              );
              await appendAudit(
                db,
                { action: 'signin.start', requestId: rid, detail: { provider: p } },
                t,
              );
              return send(
                res,
                303,
                { ok: true },
                {
                  location: flow.url,
                  'set-cookie': txCookie(txValue, TX_TTL_MS / 1000),
                },
              );
            }
            if (path === '/auth/email/start') {
              route = 'auth_start_email';
              if (!config.email) return send(res, 404, err('not_found', 'not found'));
              const t = now();
              const rawEmail = form.get('email') ?? '';
              const address = emailAddress(rawEmail);
              // The answer never says whether the address has an account — there is no lookup to
              // reveal. A malformed address is the one thing refused here, on the sign-in page
              // with the field error the copy spec names (empty is its own string).
              if (!address)
                return sendHtml(
                  res,
                  400,
                  signInPage({
                    providers: PROVIDERS.filter((x) => config.providers[x]),
                    email: true,
                    error: {
                      message:
                        rawEmail.trim() === ''
                          ? 'Enter an email address.'
                          : 'Enter a full email address.',
                      value: rawEmail,
                    },
                  }),
                );
              const client = clientKey(req);
              const addr = hashSecret(inboxKey(address));
              const allowed =
                (await hit(
                  db,
                  {
                    bucket: `email-client:${client}`,
                    max: EMAIL_PER_CLIENT,
                    windowMs: EMAIL_WINDOW_MS,
                  },
                  t,
                )) &&
                (await hit(
                  db,
                  {
                    bucket: `email-address-client:${addr}:${client}`,
                    max: EMAIL_PER_ADDRESS_CLIENT,
                    windowMs: EMAIL_WINDOW_MS,
                  },
                  t,
                )) &&
                (await hit(
                  db,
                  {
                    bucket: `email-address:${addr}`,
                    max: EMAIL_PER_ADDRESS,
                    windowMs: EMAIL_WINDOW_MS,
                  },
                  t,
                ));
              if (
                !(await hit(
                  db,
                  { bucket: 'email-send-watch', max: EMAIL_SEND_WATCH, windowMs: EMAIL_WINDOW_MS },
                  t,
                ))
              )
                log.warn('signin_email_volume_high', { rid, per_hour_over: EMAIL_SEND_WATCH });
              if (!allowed) return sendHtml(res, 429, errorPages.rate(), { 'retry-after': '900' });
              const token = newSecret();
              const txValue = await createMagicTx(
                db,
                { email: address, token, returnPath: safeReturnPath(form.get('return')) },
                t,
              );
              const link = `${config.issuer}/auth/email/confirm?t=${token}`;
              const sent = await (deps.sendEmail ?? sendSignInEmail)(config.email, {
                to: address,
                link,
                expiresMinutes: MAGIC_TTL_MS / 60_000,
              }).catch(() => false);
              await appendAudit(
                db,
                { action: 'signin.start', requestId: rid, detail: { provider: 'email', sent } },
                t,
              );
              if (!sent) log.warn('signin_email_not_sent', { rid });
              // Copy spec §3: check-your-email is also the answer when the send failed for any
              // reason other than the rate limit — the page never says whether it sent.
              return sendHtml(res, 200, checkEmailPage(address), {
                'set-cookie': txCookie(txValue, MAGIC_TTL_MS / 1000),
              });
            }
            if (path === '/auth/email/confirm') {
              route = 'auth_confirm_email';
              if (!config.email) return send(res, 404, err('not_found', 'not found'));
              const t = now();
              const done = await consumeMagic(db, form.get('t'), cookie(req, TX_COOKIE), t);
              const clearTx = { 'set-cookie': txCookie('', 0) };
              if (!done) {
                await appendAudit(
                  db,
                  {
                    action: 'signin.result',
                    requestId: rid,
                    detail: { provider: 'email', ok: false, reason: 'link_invalid' },
                  },
                  t,
                );
                return sendHtml(res, 400, errorPages.link(), clearTx);
              }
              const identity = {
                provider: 'email' as const,
                subject: done.email,
                email: done.email,
              };
              const account = await accountFor(db, identity, t);
              if (!account) return sendHtml(res, 403, errorPages.disabled(), clearTx);
              const sid = await createSession(
                db,
                {
                  accountId: account.accountId,
                  method: 'email',
                  identityProvider: 'email',
                  identitySubject: done.email,
                },
                t,
              );
              await appendAudit(
                db,
                {
                  action: 'signin.result',
                  requestId: rid,
                  actorAccountId: account.accountId,
                  detail: { provider: 'email', ok: true, created: account.created },
                },
                t,
              );
              await appendAudit(
                db,
                {
                  action: 'session.issue',
                  requestId: rid,
                  actorAccountId: account.accountId,
                  detail: { method: 'email' },
                },
                t,
              );
              res.setHeader('set-cookie', [
                hostCookie('session', sid, ABSOLUTE_MS / 1000),
                txCookie('', 0),
              ]);
              return send(res, 303, { ok: true }, { location: done.returnPath });
            }
            if (path === '/logout') {
              route = 'logout';
              const sid = cookie(req, SESSION_COOKIE);
              const t = now();
              const session = await loadSession(db, sid, t);
              const clear = { 'set-cookie': hostCookie('session', '', 0), location: '/' };
              if (!session) return send(res, 303, { ok: true }, clear);
              if (!csrfTokenValid(sid!, form.get('csrf')))
                return send(res, 403, err('forbidden', 'forbidden'));
              await revokeSession(db, session.idHash, 'logout', t);
              await appendAudit(
                db,
                {
                  action: 'session.revoke',
                  requestId: rid,
                  actorAccountId: session.accountId,
                  detail: { reason: 'logout' },
                },
                t,
              );
              return send(res, 303, { ok: true }, clear);
            }
          }
          const readOnlyGet =
            (req.method === 'GET' || req.method === 'HEAD') && path === '/auth/email/confirm';
          if (
            ((req.method !== 'GET' && req.method !== 'HEAD') || POST_ROUTES.has(path)) &&
            !readOnlyGet
          ) {
            route = 'method_not_allowed';
            return send(res, 405, err('method_not_allowed', 'method not allowed'), {
              allow: POST_ROUTES.has(path) ? 'POST' : 'GET, HEAD',
            });
          }
          if (path === '/auth/email/confirm' && (req.method === 'GET' || req.method === 'HEAD')) {
            // ADR 620 decision 6: the link's GET only SHOWS — it never consumes or signs in, so a
            // mail scanner or prefetcher that follows it changes nothing. The page then POSTs.
            route = 'auth_confirm_email_view';
            if (!config.email) return send(res, 404, err('not_found', 'not found'));
            const token = new URLSearchParams((req.url ?? '').split('?')[1] ?? '').get('t');
            const state = await lookupMagic(db, token, cookie(req, TX_COOKIE), now());
            if (state === 'confirm') return sendHtml(res, 200, finishPage(token!));
            if (state === 'other_browser') return sendHtml(res, 200, wrongBrowserPage());
            return sendHtml(res, 200, errorPages.link());
          }
          const callback = CALLBACK.exec(path);
          if (callback) {
            const p = callback[1] as ProviderId;
            route = `auth_callback_${p}`;
            const creds = config.providers[p];
            if (!creds) return send(res, 404, err('not_found', 'not found'));
            const t = now();
            const clearTx = { 'set-cookie': txCookie('', 0) };
            if (
              !(await hit(
                db,
                {
                  bucket: `callback:${clientKey(req)}`,
                  max: CALLBACK_PER_CLIENT,
                  windowMs: WINDOW_MS,
                },
                t,
              ))
            )
              return sendHtml(res, 429, errorPages.rate(), { 'retry-after': '60' });
            const query = (req.url ?? '').split('?')[1] ?? '';
            const params = new URLSearchParams(query);
            const tx = await consumeOAuthTx(db, cookie(req, TX_COOKIE), p, params.get('state'), t);
            const fail = async (code: string, status = 400) => {
              await appendAudit(
                db,
                {
                  action: 'signin.result',
                  requestId: rid,
                  detail: { provider: p, ok: false, reason: code },
                },
                t,
              );
              // A failed sign-in never redirects to a caller-chosen path (ADR 620 decision 8);
              // it renders its error page here. The provider's own error text stays off it.
              const page =
                code === 'account_disabled'
                  ? errorPages.disabled()
                  : code === 'signin_expired'
                    ? signInPage({
                        providers: PROVIDERS.filter((x) => config.providers[x]),
                        email: Boolean(config.email),
                        expired: true,
                      })
                    : p === 'github'
                      ? errorPages.github()
                      : errorPages.google();
              return sendHtml(res, status, page, clearTx);
            };
            if (!tx) return fail('signin_expired');
            if (params.has('error')) return fail('provider_refused');
            let identity;
            try {
              identity = await finishFlow(p, creds, config.issuer, query, tx, deps.providers);
            } catch (e) {
              log.warn('signin_exchange_failed', {
                rid,
                provider: p,
                kind: e instanceof Error ? e.name : typeof e,
              });
              return fail('provider_refused');
            }
            const account = await accountFor(db, identity, t);
            if (!account) return fail('account_disabled', 403);
            const sid = await createSession(
              db,
              {
                accountId: account.accountId,
                method: p,
                identityProvider: identity.provider,
                identitySubject: identity.subject,
              },
              t,
            );
            await appendAudit(
              db,
              {
                action: 'signin.result',
                requestId: rid,
                actorAccountId: account.accountId,
                detail: { provider: p, ok: true, created: account.created },
              },
              t,
            );
            await appendAudit(
              db,
              {
                action: 'session.issue',
                requestId: rid,
                actorAccountId: account.accountId,
                detail: { method: p },
              },
              t,
            );
            res.setHeader('set-cookie', [
              hostCookie('session', sid, ABSOLUTE_MS / 1000),
              txCookie('', 0),
            ]);
            return send(res, 303, { ok: true }, { location: tx.returnPath });
          }
          const asset = assetFor(path);
          if (asset && (req.method === 'GET' || req.method === 'HEAD')) {
            route = 'asset';
            res.writeHead(200, {
              ...SECURITY_HEADERS,
              'content-security-policy': PAGE_CSP,
              'content-type': asset.type,
              'content-length': asset.body.length,
              'cache-control': asset.cache,
            });
            return res.end(req.method === 'HEAD' ? undefined : asset.body);
          }
          if (path === '/' || path === '/account') {
            route = path === '/' ? 'signin_page' : 'account_page';
            const sid = cookie(req, SESSION_COOKIE);
            const session = await loadSession(db, sid, now());
            if (path === '/account') {
              if (!session)
                return sendHtml(res, 303, '', {
                  location: '/',
                  'set-cookie': hostCookie('session', '', 0),
                });
              return sendHtml(
                res,
                200,
                accountPage({
                  methods: await methodsOf(db, session.accountId, {
                    provider: session.identityProvider,
                    subject: session.identitySubject,
                  }),
                  csrf: csrfTokenFor(sid!),
                }),
              );
            }
            if (session) return sendHtml(res, 303, '', { location: '/account' });
            // A session cookie that no longer loads is an expired sign-in (copy spec §2):
            // show the banner once and clear it, so a fresh visit never sees it.
            const stale = sid !== undefined;
            return sendHtml(
              res,
              200,
              signInPage({
                providers: PROVIDERS.filter((x) => config.providers[x]),
                email: Boolean(config.email),
                expired: stale,
              }),
              stale ? { 'set-cookie': hostCookie('session', '', 0) } : {},
            );
          }
          if (path === '/me') {
            // The JSON view of who is signed in; the signed-in page itself is GET /account.
            route = 'me';
            const session = await loadSession(db, cookie(req, SESSION_COOKIE), now());
            if (!session) return send(res, 401, err('signed_out', 'not signed in'));
            return send(res, 200, {
              account_id: session.accountId,
              method: session.method,
              authenticated_at: session.authenticatedAt,
              methods: (await methodsOf(db, session.accountId)).map(({ provider, email }) => ({
                provider,
                email,
              })),
              providers: PROVIDERS.filter((x) => config.providers[x]),
            });
          }
          if (path === '/health') {
            route = 'health';
            try {
              await db.query('SELECT 1');
            } catch {
              return send(res, 503, { ok: false, reason: DATABASE_UNREACHABLE_SENTENCE });
            }
            return send(res, 200, { ok: true, build: config.build });
          }
          if (path === '/.well-known/jwks.json') {
            route = 'jwks';
            // ADR 615: published from day one so team servers code against the real URL; empty
            // until the KMS lane (01M3Z43V58) puts a key in it. An empty set verifies nothing.
            return send(res, 200, { keys: [] }, { 'cache-control': 'public, max-age=300' });
          }
          return send(res, 404, err('not_found', 'not found'));
        } catch (e) {
          log.error('http_error', { rid, route, kind: e instanceof Error ? e.name : typeof e });
          if (!res.headersSent) {
            // Browser flows get the unknown-failure page with the request id (copy spec §7);
            // the JSON routes keep the one error shape. Never the exception's text either way.
            const p = (req.url ?? '').split('?')[0] ?? '';
            if (p === '/' || p === '/account' || p.startsWith('/auth/') || p === '/logout')
              sendHtml(res, 500, errorPages.unknown(rid));
            else send(res, 500, err('internal', 'internal error'));
          }
        }
      })();
    },
  );
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
