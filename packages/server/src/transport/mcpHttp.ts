import { AsyncLocalStorage } from 'node:async_hooks';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createMcpHandler,
  type McpHttpHandler,
  type McpServer,
} from '@modelcontextprotocol/server';
import type { Capabilities } from '@musterd/protocol';
import { teamCtx, type Ctx } from '../context.js';
import { asMusterdHttpError, MusterdError, ServiceUnavailable } from '../errors.js';
import { noteRequestFailure } from '../log.js';
import { authMember, touchSeen } from '../store/members.js';
import { touchAmbientPresence } from '../store/presence.js';
import { resolveCapabilities } from '../store/rows.js';
import { isTlsPeer, requireTeamRedacted } from './oauth.js';
import { originFrom } from './sponsoredAgentMint.js';

/**
 * The remote-MCP rail (ADR 446 §1): the musterd adapter served as Streamable HTTP at
 * `POST|GET /mcp/:team`, so a phone app adds one connector URL and signs in as a seat.
 *
 * The daemon keeps the edge and implements no tools (ADR 630). It owns OAuth (`oauth.ts`), bearer
 * verification, the per-team handler, the 1 MiB body cap and the challenge; the tools are the
 * adapter's own, built per request by the {@link RemoteMcpFactory} the embedder composes in
 * (`musterd serve` passes `@musterd/mcp`'s `buildRemoteMcpServer`, ADR 002's launcher exception).
 * They call this daemon back over loopback with the phone's bearer, so a phone gets every route's
 * whole behaviour, and nothing here can drift from the desk adapter.
 *
 * The SDK's `createMcpHandler` serves the Streamable HTTP exchange (initialize, tools/list,
 * tools/call, session ids) and asks the factory for a fresh `McpServer` per request — never one
 * shared across callers.
 */

/** One remote request's seat, as the factory receives it (ADR 630 §2). */
export interface RemoteMcpSeat {
  /** This daemon, as the factory's loopback calls reach it: the socket the phone arrived on. */
  server: string;
  team: string;
  member: string;
  /** The phone's `msat_`, re-presented on every loopback call so each is re-authenticated. */
  bearer: string;
  /** The seat's effective capabilities (ADR 621 §8) — `tools/list` is scoped by them. */
  capabilities: Capabilities;
  /**
   * The phone's edge, to present on every loopback call (ADR 630, 2026-10-17 note): `host` and
   * `x-forwarded-proto` so the Cloud host gate and the connect-link origin see the team's public
   * host rather than an IP, and `cf-connecting-ip` so the per-client budget charges the phone, not
   * the daemon. Only headers the phone's own request carried; never a credential.
   */
  headers: Record<string, string>;
}

/** Builds the MCP server for one remote request. Absent, `/mcp/:team` tool traffic answers 503. */
export type RemoteMcpFactory = (seat: RemoteMcpSeat) => McpServer | Promise<McpServer>;

/** The stable sentence a daemon with no factory answers (ADR 630 §8). */
export const REMOTE_MCP_NOT_CONFIGURED = 'remote MCP not configured';

/** The edge headers a loopback call re-presents. Allowlisted: nothing else of the phone's crosses. */
const EDGE_HEADERS = ['host', 'x-forwarded-proto', 'cf-connecting-ip'] as const;

const handlers = new Map<string, McpHttpHandler>();
/** The request being served: its seat and the factory to build it with (read by the SDK factory). */
const requestSeat = new AsyncLocalStorage<{ seat: RemoteMcpSeat; factory: RemoteMcpFactory }>();
/**
 * What the per-request factory threw, if it threw (lane 01M3ZC3G35). The factory runs inside the
 * SDK, which answers a factory throw with its own bare 500 — so a store that was unreachable or out
 * of pooled connections while the factory read the team surfaced as a 500, not the 503 REST gives
 * the same cause (34 of them in the 2026-10-02 load test). The throw is kept here and answered
 * through the same boundary as every other `/mcp` failure.
 */
const factoryFailure = new AsyncLocalStorage<{ err?: unknown }>();

function getHandler(slug: string): McpHttpHandler {
  let handler = handlers.get(slug);
  if (!handler) {
    // The factory runs per request with that request's seat (ADR 446 §1); sessions the SDK holds
    // are keyed by its own session ids, and this map is keyed by team — bounded by the team count,
    // never by callers.
    handler = createMcpHandler(async () => {
      const current = requestSeat.getStore();
      if (!current) throw new Error('remote MCP factory ran outside a request');
      try {
        return await current.factory(current.seat);
      } catch (err) {
        const failure = factoryFailure.getStore();
        if (failure && failure.err === undefined) failure.err = err;
        throw err;
      }
    });
    handlers.set(slug, handler);
  }
  return handler;
}

async function toWebRequest(req: IncomingMessage, path: string, url: URL): Promise<Request> {
  // Decline 2: the bridged exchange is bounded — MCP frames carry tool args (message bodies),
  // so the cap is generous (1 MiB), but an unbounded public endpoint is a memory-exhaustion bug.
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > 1024 * 1024) throw new MusterdError('payload_too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined) continue;
    const name = k.toLowerCase();
    // Hop-by-hop and framing headers describe the node transport, not the exchange.
    if (name === 'content-length' || name === 'connection' || name === 'transfer-encoding')
      continue;
    headers.set(name, Array.isArray(v) ? v.join(', ') : v);
  }
  const hasBody =
    body.length > 0 && (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH');
  return new Request(`http://localhost${path}${url.search}`, {
    method: req.method ?? 'GET',
    headers,
    ...(hasBody ? { body: new Uint8Array(body) } : {}),
  });
}

async function sendWebResponse(res: ServerResponse, webRes: Response): Promise<void> {
  const headers: Record<string, string> = {};
  webRes.headers.forEach((v, k) => {
    const name = k.toLowerCase();
    if (name === 'content-encoding' || name === 'content-length' || name === 'connection') return;
    headers[name] = v;
  });
  headers['cache-control'] = 'no-store';
  if (!webRes.body) {
    res.writeHead(webRes.status, headers);
    return void res.end();
  }
  res.writeHead(webRes.status, headers);
  const reader = webRes.body.getReader();
  const onClose = () => void reader.cancel().catch(() => {});
  res.on('close', onClose);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(value)) await new Promise<void>((resolve) => res.once('drain', resolve));
    }
  } finally {
    res.off('close', onClose);
  }
  res.end();
}

/**
 * The RFC 6750 + RFC 9728 §5.1 challenge for `/mcp/:team` 401s (fifty's accept note on
 * 01M3AKN6GF): `resource_metadata` names this team's protected-resource document so a
 * spec-following client skips the discovery guess. The host rides the request's Host header
 * and is allowlisted to hostname characters — anything else falls back to the bare scheme,
 * never a reflected oddity. The slug is the path the client already asked for (encoded, never
 * logged); `params` carries e.g. ` error="invalid_token"`.
 */
function mcpChallenge(req: IncomingMessage, slug: string, params = ''): string {
  // The Host header is attacker-controlled: allowlist it to hostname characters and fall back
  // to the bare scheme rather than reflecting an oddity. The scheme rides the established
  // originFrom helper (x-forwarded-proto, else http — the tunnel sets it; loopback is http).
  const host = req.headers.host;
  const proto = req.headers['x-forwarded-proto'];
  if (typeof host !== 'string' || host === '' || !/^[A-Za-z0-9.:[\]-]+$/.test(host))
    return `Bearer${params}`;
  const firstProto = Array.isArray(proto) ? proto[0] : proto;
  return (
    `Bearer${params} resource_metadata="${originFrom(host, firstProto)}` +
    `/.well-known/oauth-protected-resource/mcp/${encodeURIComponent(slug)}"`
  );
}

/**
 * `POST|GET|DELETE /mcp/:team` — the connector URL. TLS-except-loopback (a bearer over
 * plaintext is a bearer leaked), bearer-authenticated per request, then handed to the SDK
 * handler whose per-request factory binds the seat. Returns true when the path belonged here.
 */
export async function handleMcpRoute(
  ctx: Ctx,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  path: string,
  url: URL,
): Promise<boolean> {
  const m = path.match(/^\/mcp\/([^/]+)$/);
  if (!m) return false;
  const slug = decodeURIComponent(m[1]!);
  // Redaction lane 01M3AMYGN5: the slug is attacker-controlled path input and may itself be
  // credential-shaped — never echo it (requireTeam's `no team "X"` would write it back out).
  const team = await requireTeamRedacted(ctx.db, slug);
  // Spec §12.1: from here the request is this team's (the caller handed us the operator ctx).
  ctx = teamCtx(ctx, team.id);
  if (!isTlsPeer(ctx, req)) {
    res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(
      JSON.stringify({
        error: {
          code: 'forbidden',
          message:
            'remote MCP is refused over plaintext — reach the daemon through the TLS tunnel (or loopback for local testing)',
        },
      }),
    );
    return true;
  }
  const h = req.headers['authorization'];
  const bearer = h?.startsWith('Bearer ') ? h.slice('Bearer '.length).trim() : '';
  if (!bearer) {
    // RFC 6750 §3: a 401 from a protected resource names the scheme so the client knows
    // how to authenticate (ryder's #1694 review note — the 401 carried no header at all).
    res.writeHead(401, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'www-authenticate': mcpChallenge(req, slug),
    });
    res.end(JSON.stringify({ error: { code: 'unauthorized', message: 'missing bearer token' } }));
    return true;
  }
  const actingSeat = req.headers['x-musterd-seat'];
  const seatHeader = Array.isArray(actingSeat) ? actingSeat[0] : actingSeat;
  let member: Awaited<ReturnType<typeof authMember>>['member'];
  try {
    const auth = await authMember(
      ctx.db,
      slug,
      bearer,
      seatHeader && seatHeader.length > 0 ? seatHeader : undefined,
    );
    member = auth.member;
  } catch (err) {
    const me = asMusterdHttpError(err);
    if (me.httpStatus >= 500) noteRequestFailure(res, err);
    // RFC 6750 §3: an invalid/expired/revoked bearer 401s as invalid_token. The description
    // stays out of the header — the body already says it, and the header must not become an
    // oracle finer than the body. Non-401s (seat mismatch 403s, etc.) ride exactly as before.
    res.writeHead(me.httpStatus, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      ...(me.httpStatus === 401
        ? { 'www-authenticate': mcpChallenge(req, slug, ' error="invalid_token"') }
        : {}),
    });
    res.end(JSON.stringify(me.toBody()));
    return true;
  }
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') {
    res.writeHead(405, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ error: { code: 'bad_request', message: 'method not allowed' } }));
    return true;
  }
  // Ambient presence (ADR 057 §4): the tool call IS the heartbeat — stamp it, and announce the
  // flip like authTouch does. Humans stamp no model/provenance (ADR 121); the surface reads
  // `other` (no remote surface in the enum; rehearsal may name one).
  await touchSeen(ctx.db, member.id);
  if (await touchAmbientPresence(ctx.db, member.id, 'other', ctx.config.presenceTimeoutMs)) {
    ctx.hub.broadcastTeam(team.id, { type: 'presence', member: member.name, status: 'online' });
  }
  // ADR 630 §8: no factory, no tools. The OAuth routes (oauth.ts) answer either way.
  const factory = ctx.remoteMcp;
  if (!factory) {
    const me = new ServiceUnavailable(REMOTE_MCP_NOT_CONFIGURED);
    res.writeHead(me.httpStatus, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(JSON.stringify(me.toBody()));
    return true;
  }
  const seat: RemoteMcpSeat = {
    server: loopbackBase(ctx, req),
    team: slug,
    member: member.name,
    bearer,
    capabilities: resolveCapabilities(member),
    headers: edgeHeaders(ctx, req),
  };
  try {
    const webReq = await toWebRequest(req, path, url);
    const failure: { err?: unknown } = {};
    const webRes = await requestSeat.run({ seat, factory }, () =>
      factoryFailure.run(failure, async () => getHandler(slug).fetch(webReq)),
    );
    if (failure.err !== undefined) {
      // The SDK's own answer to the factory throw is a bare 500; answer the cause instead.
      await webRes.body?.cancel().catch(() => {});
      throw failure.err;
    }
    await sendWebResponse(res, webRes);
  } catch (err) {
    const me = asMusterdHttpError(err);
    if (me.httpStatus >= 500) noteRequestFailure(res, err);
    // A store that is unreachable or out of pooled connections is a 503 with its stable sentence,
    // as on REST (lane 01M3ZC3G35); anything else is a 500 with no secret.
    if (!res.headersSent) {
      res.writeHead(me.httpStatus, {
        'content-type': 'application/json',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(me.toBody()));
    }
  }
  return true;
}

/**
 * This daemon as its own loopback calls reach it: the local end of the socket the phone arrived
 * on, which is a listening address of this process by construction — whatever the bind (loopback,
 * a tailnet IP, `0.0.0.0` on Fly). Native TLS keeps the scheme; the edge `host` the calls present
 * is the name the certificate was issued for.
 */
function loopbackBase(ctx: Ctx, req: IncomingMessage): string {
  const raw = req.socket.localAddress ?? '127.0.0.1';
  const addr = raw.replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1');
  const host = addr.includes(':') ? `[${addr}]` : addr;
  const scheme = ctx.config.tls ? 'https' : 'http';
  return `${scheme}://${host}:${req.socket.localPort ?? ctx.config.port}`;
}

/**
 * The phone's edge headers, as {@link RemoteMcpSeat.headers} describes. `cf-connecting-ip` only
 * under `trustProxy` — the only posture in which any limiter reads it (`clientIp`,
 * `requestBudgetClient`), and the one where the Cloudflare edge wrote it, so a loopback call
 * carries exactly the key the phone's own request was charged under and nothing a caller chose.
 * Without `trustProxy` (a self-hosted daemon) a loopback call keys on the daemon's own address:
 * every phone's sub-requests share that one bucket, as every tunnel-borne request already shares
 * the `cloudflared` peer's. Separating them needs a channel a caller cannot forge; Cloud, where the
 * budget is enforced, does not.
 */
function edgeHeaders(ctx: Ctx, req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of EDGE_HEADERS) {
    if (name === 'cf-connecting-ip' && !ctx.config.trustProxy) continue;
    const v = req.headers[name];
    const value = Array.isArray(v) ? v[0] : v;
    if (value) out[name] = value;
  }
  return out;
}

/** Test seam: drop cached handlers (per-team singletons) between isolated test servers. */
export function resetMcpHandlersForTest(): void {
  handlers.clear();
}
