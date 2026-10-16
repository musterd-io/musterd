import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { appendAudit } from './audit.js';
import type { ConsoleConfig } from './config.js';
import { hostCookie } from './cookies.js';
import { csrfTokenValid, originAllowed } from './csrf.js';
import { DATABASE_UNREACHABLE_SENTENCE, type Queryable } from './db.js';
import type { Log } from './log.js';
import { cookie, FormError, readForm, SESSION_COOKIE } from './request.js';
import { loadSession, revokeSession } from './sessions.js';

/**
 * The console's HTTP boundary (ADR 615). The skeleton serves exactly two routes — `GET /health`
 * and `GET /.well-known/jwks.json` (an empty key set) — and refuses everything else. No sign-in,
 * signing, identity binding or team provisioning route exists until its own lane, and there is no
 * development issuer or test key to fall back to: an empty JWKS authenticates no one.
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
}

/** Routes that change state, and the only paths a POST may reach (ADR 620 decision 8). */
const POST_ROUTES = new Set(['/logout']);

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

export function createConsoleServer(deps: ConsoleDeps): Server {
  const { config, db, log } = deps;
  const now = deps.now ?? Date.now;
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
          if ((req.method !== 'GET' && req.method !== 'HEAD') || POST_ROUTES.has(path)) {
            route = 'method_not_allowed';
            return send(res, 405, err('method_not_allowed', 'method not allowed'), {
              allow: POST_ROUTES.has(path) ? 'POST' : 'GET, HEAD',
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
          if (!res.headersSent) send(res, 500, err('internal', 'internal error'));
        }
      })();
    },
  );
  server.headersTimeout = HEADERS_TIMEOUT_MS;
  return server;
}
