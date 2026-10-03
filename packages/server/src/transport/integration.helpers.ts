import { get as httpGet, type IncomingHttpHeaders } from 'node:http';
import { PROTOCOL_VERSION, type WSServerFrame } from '@musterd/protocol';
import { afterEach, beforeEach, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { Driver } from '../db/driver.js';
import { type DriverKind, openTestDriver } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';

/**
 * A bare string is a self-identifying secret — a human `mscr_` credential. Agent fixtures begin
 * with the bootstrap `mskey_`, then the transport helper claims their named seat and substitutes
 * the resulting `msac_` credential plus `msls_` Presence proof (ADR 337).
 */
export type Auth = string | { key: string; seat: string; sessionLease?: string };
type TeamBootstrap = { agentKey: string; humanCredential: string };

/**
 * The server-over-the-wire harness every `integration.*.test.ts` file shares (lane 01M3ZRPWDB, the
 * ADR 498 follow-up that split the one 11k-line file so the coverage shards can balance). Call it
 * once inside `withDrivers`: it registers the per-test server lifecycle and hands back the HTTP/WS
 * helpers. `h.server`, `h.base`, `h.wsUrl` and `h.db` are read at call time, so a describe that
 * stands the server up again (ADR 444's grace restarts) assigns them and every helper follows.
 */
export function integrationHarness(kind: DriverKind) {
  const h = {
    server: undefined as unknown as RunningServer,
    base: '',
    wsUrl: '',
    /** The same handle the server holds — tests that need to reach past the API keep it here. */
    db: undefined as unknown as Driver,
  };
  const configBefore = process.env['MUSTERD_CONFIG'];

  beforeEach(async () => {
    teamBootstraps.clear();
    agentAuthorities.clear();
    h.db = await openTestDriver(kind);
    h.server = createServer({ db: h.db, port: 0 });
    const { port } = await h.server.listen();
    h.base = `http://127.0.0.1:${port}`;
    h.wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  afterEach(async () => {
    await h.server.close();
    // Process-global state a test may leave behind (a Math.random spy, a MUSTERD_CONFIG pointing
    // into a deleted tmpdir) must not reach the next test — the split files no longer share an order.
    vi.restoreAllMocks();
    if (configBefore === undefined) delete process.env['MUSTERD_CONFIG'];
    else process.env['MUSTERD_CONFIG'] = configBefore;
  });

  /** Poll a predicate until it's true or we time out (for state the server reaches asynchronously). */
  async function pollUntil(pred: () => boolean | Promise<boolean>, ms = 1000): Promise<void> {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('pollUntil timed out');
  }

  const teamBootstraps = new Map<string, TeamBootstrap>();
  const agentAuthorities = new Map<string, Auth>();

  function authHeaders(auth?: Auth): Record<string, string> {
    if (!auth) return {};
    if (typeof auth === 'string') return { authorization: `Bearer ${auth}` };
    return {
      authorization: `Bearer ${auth.key}`,
      ...(auth.sessionLease ? { 'x-musterd-session-lease': auth.sessionLease } : {}),
      'x-musterd-seat': auth.seat,
    };
  }

  async function resolveAuth(path: string, auth?: Auth): Promise<Auth | undefined> {
    if (!auth || typeof auth === 'string' || !auth.key.startsWith('mskey_')) return auth;
    const slug = path.match(/^\/teams\/([^/?]+)/)?.[1];
    if (!slug) return auth;
    const bootstrap = teamBootstraps.get(slug);
    if (!bootstrap || bootstrap.agentKey !== auth.key) return auth;
    const cacheKey = `${slug}:${auth.seat}`;
    const cached = agentAuthorities.get(cacheKey);
    if (cached) {
      Object.assign(auth, cached);
      return cached;
    }

    const grantResponse = await fetch(h.base + `/teams/${slug}/grants`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${bootstrap.humanCredential}`,
      },
      body: JSON.stringify({ scope: 'seat', target: auth.seat, lifetime: 'standing' }),
    });
    const grant = (await grantResponse.json()) as { token: string };
    const claimResponse = await fetch(h.base + `/teams/${slug}/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        key: auth.key,
        target: { seat: auth.seat },
        grant: grant.token,
        surface: 'cli',
      }),
    });
    const claim = (await claimResponse.json()) as {
      seat_credential: string;
      session_lease: string;
    };
    const authority: Auth = {
      key: claim.seat_credential,
      seat: auth.seat,
      sessionLease: claim.session_lease,
    };
    agentAuthorities.set(cacheKey, authority);
    Object.assign(auth, authority);
    return authority;
  }

  async function reattestAgentModel(slug: string, auth: Exclude<Auth, string>, model: string) {
    const claim = await post(`/teams/${slug}/claim`, {
      key: auth.key,
      target: { seat: auth.seat },
      surface: 'cli',
      model,
    });
    if (claim.status !== 200) throw new Error(`failed to reattest ${auth.seat}: ${claim.status}`);
    Object.assign(auth, {
      key: claim.json.seat_credential ?? auth.key,
      sessionLease: claim.json.session_lease,
    });
  }

  async function post(path: string, body: unknown, auth?: Auth) {
    const resolvedAuth = await resolveAuth(path, auth);
    const res = await fetch(h.base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...authHeaders(resolvedAuth),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (path === '/teams' && res.status === 201) {
      teamBootstraps.set(json.team.slug, {
        agentKey: json.agent_key,
        humanCredential: json.human_credential,
      });
    }
    return { status: res.status, json };
  }

  async function get(path: string, auth?: Auth, extraHeaders?: Record<string, string>) {
    const resolvedAuth = await resolveAuth(path, auth);
    const res = await fetch(h.base + path, {
      headers: {
        ...authHeaders(resolvedAuth),
        ...(extraHeaders ?? {}),
      },
    });
    return { status: res.status, json: (await res.json()) as any };
  }

  /** Like `post` but for a JSON-bodied request of any method; parses JSON only when a body is returned. */
  async function req(method: string, path: string, body: unknown, auth?: Auth) {
    const resolvedAuth = await resolveAuth(path, auth);
    const res = await fetch(h.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...authHeaders(resolvedAuth) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  /**
   * Raw GET against the test server: unlike undici's `fetch` (which auto-decodes and hides the header)
   * it never decompresses, so tests can assert the exact `content-encoding` and diff the raw body.
   */
  function rawHttpGet(
    path: string,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      httpGet(h.base + path, { headers }, (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c) => chunks.push(c as Buffer));
        r.on('end', () =>
          resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
        );
      }).on('error', reject);
    });
  }

  /** Mint a standing seat grant (admin-authed) so an agent WS-claim occupies immediately, not pending. */
  async function standingGrant(adminAuth: Auth, seat: string): Promise<string> {
    const r = await post(
      '/teams/dawn/grants',
      { scope: 'seat', target: seat, lifetime: 'standing' },
      adminAuth,
    );
    return r.json.token as string;
  }

  /** A test WS client that records frames and lets you await a specific type. */
  class TestWs {
    ws: WebSocket;
    frames: WSServerFrame[] = [];
    waiters: { type: string; resolve: (f: WSServerFrame) => void }[] = [];
    /** When each frame arrived — timing is asserted between frames, never against the wall clock. */
    arrived = new Map<WSServerFrame, number>();
    constructor() {
      this.ws = new WebSocket(h.wsUrl);
      this.ws.on('message', (d) => {
        const f = JSON.parse(d.toString()) as WSServerFrame;
        this.arrived.set(f, performance.now());
        this.frames.push(f);
        this.waiters = this.waiters.filter((w) => {
          if (w.type === f.type) {
            w.resolve(f);
            return false;
          }
          return true;
        });
      });
    }
    open() {
      return new Promise<void>((r) => this.ws.on('open', () => r()));
    }
    /** performance.now() when `f` arrived on this socket. */
    receivedAt(f: WSServerFrame): number {
      return this.arrived.get(f)!;
    }
    send(frame: unknown) {
      this.ws.send(JSON.stringify(frame));
    }
    // The default is only ever a POSITIVE wait's patience: every "must not arrive" check passes
    // its own short window. 1 s was too little for an `occupied` on the PGlite double under
    // coverage (main and #1922, 2026-10-01), and a longer default slows only a test already failing.
    waitFor(type: string, ms = 5000): Promise<WSServerFrame> {
      const existing = this.frames.find((f) => f.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), ms);
        this.waiters.push({
          type,
          resolve: (f) => {
            clearTimeout(t);
            resolve(f);
          },
        });
      });
    }
    /**
     * v0.3 claim handshake (ADR 077). `key` is the team agent key (mskey_) or a human credential (mscr_);
     * an agent seat needs a `grant` to occupy immediately (else the server opens a pending request). The
     * success frame is `occupied` (the governed successor to `welcome`).
     */
    claim(
      team: string,
      key: string,
      seat: string,
      surface = 'cli',
      grant?: string,
      model?: string,
      driver?: string,
      // Appended LAST on purpose: inserting it beside `model` would have silently re-read the
      // existing `undefined, 'nick' // driver` caller's driver as a model source.
      modelSource?: string,
    ) {
      this.send({
        type: 'claim',
        v: PROTOCOL_VERSION,
        team,
        key,
        target: { seat },
        ...(grant ? { grant } : {}),
        ...(model ? { model } : {}),
        ...(model && modelSource ? { model_source: modelSource } : {}),
        ...(driver ? { driver } : {}),
        surface,
      });
      return this.waitFor('occupied');
    }
    subscribe(scope: 'team' | 'team-all' = 'team') {
      this.send({ type: 'subscribe', scope });
      return this.waitFor('subscribed');
    }
    countFrames(type: string) {
      return this.frames.filter((f) => f.type === type).length;
    }
    /** Resolves when the server closes this socket — the "you are done here" signal a client needs. */
    closed(ms = 1000): Promise<void> {
      if (this.ws.readyState === this.ws.CLOSED) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timeout waiting for close')), ms);
        this.ws.on('close', () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
    close() {
      this.ws.close();
    }
  }

  return Object.assign(h, {
    teamBootstraps,
    pollUntil,
    authHeaders,
    resolveAuth,
    reattestAgentModel,
    post,
    get,
    req,
    rawHttpGet,
    standingGrant,
    TestWs,
  });
}
