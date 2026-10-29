import { describe, expect, it, vi } from 'vitest';
import worker, { TeamRelay, type Env } from './index.js';

// The Workers runtime's hibernation auto-response pair (ADR 756), absent under node. Assigned,
// not stubbed: the tests below `unstubAllGlobals` after each fetch stub.
(globalThis as Record<string, unknown>)['WebSocketRequestResponsePair'] = class {
  constructor(
    readonly request: string,
    readonly response: string,
  ) {}
};

/**
 * The callback route's missing-config refusals (ADR 668 §1/§2): a Slack-shaped callback is
 * forwarded only with a verified signature and a mapping. Each test stops before the Durable
 * Object when refused; the forwarded case uses a stub namespace that records the call.
 */

function slackBody(teamId = 'T1'): string {
  return `payload=${encodeURIComponent(
    JSON.stringify({
      team: { id: teamId },
      user: { id: 'U1' },
      actions: [{ action_id: 'musterd_approve', value: 'tok' }],
    }),
  )}`;
}

async function sign(secret: string, body: string, ts: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`v0:${ts}:${body}`));
  return 'v0=' + [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function env(partial: Partial<Env>): { env: Env; forwarded: ReturnType<typeof vi.fn> } {
  const forwarded = vi.fn(async (req: Request) => {
    if (new URL(req.url).pathname.startsWith('/install-state/'))
      return new Response(JSON.stringify({ registered: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    return new Response('forwarded', { status: 200 });
  });
  const full = {
    AWAY_RELAY: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: forwarded }),
    },
    ...partial,
  } as unknown as Env;
  return { env: full, forwarded };
}

/** A relay-object stub that holds daemon-minted state hashes for named teams only. */
function relayStateStub(registeredByTeam: Map<string, Set<string>>) {
  return {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const m = /^\/install-state\/([0-9a-f]{64})$/.exec(url.pathname);
        if (m)
          return new Response(
            JSON.stringify({ registered: registeredByTeam.get(id)?.has(m[1]!) ?? false }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        return new Response('held', { status: 200 });
      },
    }),
  };
}

async function sha256HexOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request('https://relay.example/callback/revive/ask-1', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  });
}

describe('away-relay callback route: Slack fails closed (ADR 668)', () => {
  it('rejects an unconfigured callback format', async () => {
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(post(JSON.stringify({ token: 'tok', decision: 'approve' })), e);
    expect(res.status).toBe(400);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('refuses a Slack callback when the signing secret is unset — never forwards it', async () => {
    const { env: e, forwarded } = env({ SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }) });
    const res = await worker.fetch(post(slackBody()), e);
    expect(res.status).toBe(503);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('refuses a signed Slack callback when the team map is unset', async () => {
    const body = slackBody();
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({ SLACK_SIGNING_SECRET: 'sekret' });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(503);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('refuses a Slack callback whose team maps to a different slug', async () => {
    const body = slackBody('T2');
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive', T2: 'other' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
  });

  it('forwards a signed, mapped Slack callback to the team object', async () => {
    const body = slackBody();
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  it('verifies a Slack form payload after another form field', async () => {
    const body = `extra=x&${slackBody()}`;
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });

  it('treats a Slack signature header as a Slack signal even for a non-form body', async () => {
    const body = JSON.stringify({ token: 'tok', decision: 'approve' });
    const ts = Math.floor(Date.now() / 1000);
    const { env: e, forwarded } = env({
      SLACK_SIGNING_SECRET: 'sekret',
      SLACK_TEAM_MAP_JSON: JSON.stringify({ T1: 'revive' }),
    });
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(403);
    expect(forwarded).not.toHaveBeenCalled();
  });
});

describe('away-relay tenant isolation (lane 01M50ZQCTW)', () => {
  it("one team's credential cannot open another team's socket", async () => {
    const sha256Hex = async (value: string) => {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
      return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
    };
    const { env: e, forwarded } = env({
      TEAM_CREDENTIALS_JSON: JSON.stringify({
        revive: await sha256Hex('revive-secret'),
        other: await sha256Hex('other-secret'),
      }),
    });
    // Team revive's credential presented on team other's connect route: refused at the
    // Worker, before any Durable Object is touched.
    const res = await worker.fetch(
      new Request('https://relay.example/teams/other/connect', {
        headers: { upgrade: 'websocket', authorization: 'Bearer revive-secret' },
      }),
      e,
    );
    expect(res.status).toBe(401);
    expect(forwarded).not.toHaveBeenCalled();
    // And the right credential for that team passes the gate (the stub answers 200).
    const ok = await worker.fetch(
      new Request('https://relay.example/teams/other/connect', {
        headers: { upgrade: 'websocket', authorization: 'Bearer other-secret' },
      }),
      e,
    );
    expect(ok.status).toBe(200);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });
});

/** An in-memory stand-in for the SlackInstalls registry object. */
function registryStub() {
  const states = new Map<string, { slug: string; consumed: boolean; destination: string | null }>();
  const installs = new Map<string, string>();
  const destinations = new Map<string, string>();
  return {
    idFromName: (name: string) => name,
    get: () => ({
      fetch: async (req: Request) => {
        const url = new URL(req.url);
        const json = (body: unknown, status = 200) =>
          new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          });
        if (req.method === 'PUT' && url.pathname === '/state') {
          const b = (await req.json()) as {
            state: string;
            slug: string;
            destination?: string | null;
          };
          states.set(b.state, {
            slug: b.slug,
            consumed: false,
            destination: b.destination ?? null,
          });
          return json({ ok: true });
        }
        const sm = /^\/state\/(.+)$/.exec(url.pathname);
        if (req.method === 'GET' && sm) {
          const row = states.get(decodeURIComponent(sm[1]!));
          return json({
            slug: row?.slug ?? null,
            destination: row?.destination ?? null,
            live: !!row && !row.consumed,
          });
        }
        if (req.method === 'PUT' && url.pathname === '/install') {
          const b = (await req.json()) as {
            state: string;
            slack_team_id: string;
            slug: string;
            destination?: string | null;
          };
          const row = states.get(b.state);
          if (row) row.consumed = true;
          installs.set(b.slack_team_id, b.slug);
          if (b.destination) destinations.set(b.slack_team_id, b.destination);
          return json({ ok: true });
        }
        const gm = /^\/slug-for\/(.+)$/.exec(url.pathname);
        if (req.method === 'GET' && gm) {
          const teamId = decodeURIComponent(gm[1]!);
          return json({
            slug: installs.get(teamId) ?? null,
            destination: destinations.get(teamId) ?? null,
          });
        }
        return json({ error: 'not found' }, 404);
      },
    }),
    installs,
    destinations,
    states,
  };
}

describe('slack install routes (ADR 668 decision 2, increment 9)', () => {
  it('install redirects to Slack; oauth exchanges once, records the mapping, and holds the token for the daemon', async () => {
    const registry = registryStub();
    const held: Request[] = [];
    const e = {
      AWAY_RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) => {
            if (new URL(req.url).pathname.startsWith('/install-state/'))
              return new Response(JSON.stringify({ registered: true }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
              });
            held.push(req);
            return new Response('held', { status: 200 });
          },
        }),
      },
      SLACK_INSTALLS: registry,
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'shh',
    } as unknown as Env;

    const install = await worker.fetch(
      new Request('https://relay.example/slack/install?team=revive&state=state-at-least-16-chars'),
      e,
    );
    expect(install.status).toBe(302);
    expect(install.headers.get('location')).toContain('https://slack.com/oauth/v2/authorize');

    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ok: true,
              access_token: 'xoxb-install-token',
              team: { id: 'T9' },
              authed_user: { id: 'U9' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );
    try {
      const oauth = await worker.fetch(
        new Request('https://relay.example/slack/oauth?code=abc&state=state-at-least-16-chars'),
        e,
      );
      expect(oauth.status).toBe(200);
      expect(registry.installs.get('T9')).toBe('revive');
      expect(held).toHaveLength(1);
      const heldBody = (await held[0]!.clone().json()) as Record<string, unknown>;
      expect(heldBody).toMatchObject({ slack_team_id: 'T9', bot_token: 'xoxb-install-token' });
      // The state is consumed: a replayed return with the same state is refused.
      const replay = await worker.fetch(
        new Request('https://relay.example/slack/oauth?code=abc&state=state-at-least-16-chars'),
        e,
      );
      expect(replay.status).toBe(403);
      // An unknown state never reaches the exchange.
      const unknown = await worker.fetch(
        new Request('https://relay.example/slack/oauth?code=abc&state=never-issued-state-x'),
        e,
      );
      expect(unknown.status).toBe(403);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a state registered by one team cannot start an install for another (lazara falsifier)', async () => {
    const registry = registryStub();
    const state = 'victim-state-at-least-16';
    const hash = await sha256HexOf(state);
    const e = {
      AWAY_RELAY: relayStateStub(new Map([['revive', new Set([hash])]])),
      SLACK_INSTALLS: registry,
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'shh',
    } as unknown as Env;
    // The victim team's own link works.
    const own = await worker.fetch(
      new Request(`https://relay.example/slack/install?team=revive&state=${state}`),
      e,
    );
    expect(own.status).toBe(302);
    // Whoever holds the link cannot re-bind it to their own team: the attacker's
    // relay object holds no such hash, so no install starts and no mapping is written.
    const rebound = await worker.fetch(
      new Request(`https://relay.example/slack/install?team=attacker&state=${state}`),
      e,
    );
    expect(rebound.status).toBe(403);
    // An entirely unregistered state is refused even for a well-formed slug.
    const invented = await worker.fetch(
      new Request('https://relay.example/slack/install?team=revive&state=invented-state-16ch'),
      e,
    );
    expect(invented.status).toBe(403);
  });

  it('callback dispatch follows the install record even with no operator map', async () => {
    const registry = registryStub();
    registry.installs.set('T9', 'revive');
    const { env: e, forwarded } = env({ SLACK_SIGNING_SECRET: 'sekret' });
    (e as unknown as { SLACK_INSTALLS: unknown }).SLACK_INSTALLS = registry;
    const body = slackBody('T9');
    const ts = Math.floor(Date.now() / 1000);
    const res = await worker.fetch(
      post(body, {
        'x-slack-request-timestamp': String(ts),
        'x-slack-signature': await sign('sekret', body, ts),
      }),
      e,
    );
    expect(res.status).toBe(200);
    expect(forwarded).toHaveBeenCalledTimes(1);
    // The same payload at another team's URL is refused, never re-routed.
    const wrong = await worker.fetch(
      new Request('https://relay.example/callback/other/ask-1', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-slack-request-timestamp': String(ts),
          'x-slack-signature': await sign('sekret', body, ts),
        },
        body,
      }),
      e,
    );
    expect(wrong.status).toBe(403);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });
});

describe('cloud-direct dispatch (spec: Slack ingress §3, away 10)', () => {
  async function ingressKeyEnv() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const pkcs8 = (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer;
    const pem =
      '-----BEGIN PRIVATE KEY-----\n' +
      Buffer.from(pkcs8).toString('base64') +
      '\n-----END PRIVATE KEY-----';
    return { pem, publicKey: pair.publicKey };
  }

  it('a cloud install is delivered attested to its server, and its callbacks follow', async () => {
    const { pem, publicKey } = await ingressKeyEnv();
    const registry = registryStub();
    const cloudPosts: { url: string; headers: Headers; body: string }[] = [];
    const e = {
      AWAY_RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) =>
            new URL(req.url).pathname.startsWith('/install-state/')
              ? new Response(
                  JSON.stringify({ registered: true, destination: 'https://cloud.example' }),
                  {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                  },
                )
              : new Response('held', { status: 200 }),
        }),
      },
      SLACK_INSTALLS: registry,
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'shh',
      INGRESS_SIGNING_KEY: pem,
      SLACK_SIGNING_SECRET: 'sekret',
    } as unknown as Env;

    const install = await worker.fetch(
      new Request('https://relay.example/slack/install?team=revive&state=cloud-state-16-chars'),
      e,
    );
    expect(install.status).toBe(302);

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.startsWith('https://slack.com/'))
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: 'xoxb-cloud-token',
              team: { id: 'T7' },
              authed_user: { id: 'U7' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        cloudPosts.push({
          url,
          headers: new Headers(init?.headers),
          body: String(init?.body ?? ''),
        });
        return new Response('ok', { status: 201 });
      }),
    );
    try {
      const oauth = await worker.fetch(
        new Request('https://relay.example/slack/oauth?code=abc&state=cloud-state-16-chars'),
        e,
      );
      expect(oauth.status).toBe(200);
      expect(cloudPosts).toHaveLength(1);
      expect(cloudPosts[0]!.url).toBe(
        'https://cloud.example/teams/revive/channels/slack/install-record',
      );
      // The attestation verifies against the ingress public key over `<ts>.<body>`.
      const ts = cloudPosts[0]!.headers.get('x-musterd-ingress-timestamp')!;
      const sig = Buffer.from(
        cloudPosts[0]!.headers.get('x-musterd-ingress-signature')!,
        'base64url',
      );
      expect(
        await crypto.subtle.verify(
          { name: 'Ed25519' },
          publicKey,
          sig,
          new TextEncoder().encode(`${ts}.${cloudPosts[0]!.body}`),
        ),
      ).toBe(true);

      // A signed Slack callback for that workspace is dispatched to the same server.
      const body = slackBody('T7');
      const slackTs = Math.floor(Date.now() / 1000);
      const cb = await worker.fetch(
        post(body, {
          'x-slack-request-timestamp': String(slackTs),
          'x-slack-signature': await sign('sekret', body, slackTs),
        }),
        e,
      );
      expect(cb.status).toBe(202);
      expect(cloudPosts).toHaveLength(2);
      expect(cloudPosts[1]!.url).toBe(
        'https://cloud.example/teams/revive/channels/slack/callback/ask-1',
      );
      expect(cloudPosts[1]!.body).toBe(body);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a dest on the install link selects nothing: only the mint-registered destination is recorded (ryder falsifier)', async () => {
    const registry = registryStub();
    const state = 'cloud-state-16-chars';
    const e = {
      AWAY_RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) =>
            new URL(req.url).pathname.startsWith('/install-state/')
              ? new Response(
                  JSON.stringify({ registered: true, destination: 'https://cloud.example' }),
                  { status: 200, headers: { 'content-type': 'application/json' } },
                )
              : new Response('held', { status: 200 }),
        }),
      },
      SLACK_INSTALLS: registry,
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'shh',
    } as unknown as Env;
    const install = await worker.fetch(
      new Request(
        `https://relay.example/slack/install?team=revive&state=${state}&dest=https://evil.example`,
      ),
      e,
    );
    expect(install.status).toBe(302);
    expect(registry.states.get(state)?.destination).toBe('https://cloud.example');

    // With no destination registered at mint, an attacker-supplied dest records none:
    // the install falls back to the relay-object transport, never the attacker's origin.
    const registry2 = registryStub();
    const e2 = {
      AWAY_RELAY: {
        idFromName: (name: string) => name,
        get: () => ({
          fetch: async (req: Request) =>
            new URL(req.url).pathname.startsWith('/install-state/')
              ? new Response(JSON.stringify({ registered: true, destination: null }), {
                  status: 200,
                  headers: { 'content-type': 'application/json' },
                })
              : new Response('held', { status: 200 }),
        }),
      },
      SLACK_INSTALLS: registry2,
      SLACK_CLIENT_ID: '123.456',
      SLACK_CLIENT_SECRET: 'shh',
    } as unknown as Env;
    const install2 = await worker.fetch(
      new Request(
        `https://relay.example/slack/install?team=revive&state=${state}&dest=https://evil.example`,
      ),
      e2,
    );
    expect(install2.status).toBe(302);
    expect(registry2.states.get(state)?.destination).toBeNull();
  });

  it('cloudDestinationFrom accepts only https origins', async () => {
    const { cloudDestinationFrom } = await import('./installs.js');
    expect(cloudDestinationFrom('https://cloud.example')).toBe('https://cloud.example');
    expect(cloudDestinationFrom('http://cloud.example')).toBeNull();
    expect(cloudDestinationFrom('https://cloud.example/path')).toBeNull();
    expect(cloudDestinationFrom('https://user@cloud.example')).toBeNull();
    expect(cloudDestinationFrom('not a url')).toBeNull();
    expect(cloudDestinationFrom(null)).toBeNull();
  });
});

describe('away-relay app routes (ADR 676 §2, §9)', () => {
  it('forwards a well-shaped app callback to the team object under its ref; refuses a malformed one', async () => {
    const { env: e, forwarded } = env({});
    const body = JSON.stringify({ app: 1, kind: 'redeliver', binding: 'b1' });
    const res = await worker.fetch(
      new Request('https://relay.example/app/revive/callback', { method: 'POST', body }),
      e,
    );
    expect(res.status).toBe(200);
    const inner = forwarded.mock.calls[0] as unknown as [Request];
    expect(new URL(inner[0].url).pathname).toBe('/callback/revive/b1');
    expect(await inner[0].text()).toBe(body);

    const bad = await worker.fetch(
      new Request('https://relay.example/app/revive/callback', {
        method: 'POST',
        body: JSON.stringify({ app: 1, kind: 'answer', binding: 'b1', ref: 'a' }),
      }),
      e,
    );
    expect(bad.status).toBe(400);
    expect(forwarded).toHaveBeenCalledTimes(1);
  });
});

/** A TeamRelay over an in-memory stand-in for its state, with one live daemon socket. */
async function relayWithSocket(extraEnv: Partial<Env> = {}, lastPingAt: Date | null = null) {
  const credentialHash = 'f'.repeat(64);
  const sent: Record<string, unknown>[] = [];
  const holder: { relay: TeamRelay | null } = { relay: null };
  const socket = {
    deserializeAttachment: () => ({ slug: 'revive', credentialHash }),
    send: (raw: string) => {
      const frame = JSON.parse(raw) as Record<string, unknown>;
      sent.push(frame);
      // The daemon answers a fetch on the same socket.
      if (frame['type'] === 'app_fetch')
        queueMicrotask(
          () =>
            void holder.relay!.webSocketMessage(
              socket as unknown as WebSocket,
              JSON.stringify({
                protocol: 1,
                type: 'app_body',
                request_id: frame['request_id'],
                sealed: frame['ask_ref'] === 'ask-1' ? { v: 1, enc: 'e', ct: 'c' } : null,
                ...(frame['ask_ref'] === 'ask-1' ? { expires_at: 99 } : {}),
              }),
            ),
        );
    },
    close: vi.fn(),
  };
  const state = {
    blockConcurrencyWhile: (fn: () => unknown) => fn(),
    storage: { sql: { exec: () => ({ toArray: () => [] }) } },
    getWebSockets: () => [socket],
    setWebSocketAutoResponse: vi.fn(),
    getWebSocketAutoResponseTimestamp: () => lastPingAt,
  };
  const relay = new TeamRelay(
    state as unknown as DurableObjectState,
    {
      TEAM_CREDENTIALS_JSON: JSON.stringify({ revive: credentialHash }),
      ...extraEnv,
    } as Env,
  );
  holder.relay = relay;
  return { relay, socket, sent };
}

/** A minimal SQL stand-in honoring the exact statements the deliver path runs. */
class FakeSql {
  deliveries: number[] = [];
  pending = new Map<string, { status: string; provider_ref: string | null }>();
  exec<T>(sql: string, ...params: unknown[]): { toArray: () => T[] } {
    const q = sql.replace(/\s+/g, ' ');
    let rows: unknown[] = [];
    if (q.includes('DELETE FROM deliveries')) {
      const cutoff = params[0] as number;
      this.deliveries = this.deliveries.filter((at) => at > cutoff);
    } else if (q.includes('SELECT COUNT(*) AS n FROM deliveries WHERE')) {
      rows = [{ n: this.deliveries.filter((at) => at > (params[0] as number)).length }];
    } else if (q.includes('SELECT COUNT(*) AS n FROM deliveries')) {
      rows = [{ n: this.deliveries.length }];
    } else if (q.includes('INSERT INTO deliveries')) {
      this.deliveries.push(params[0] as number);
    } else if (q.includes('SELECT status, provider_ref FROM pending WHERE dedupe_id')) {
      const row = [...this.pending.entries()].find(([k]) => k.endsWith(`|${params[0]}`));
      rows = row ? [{ status: row[1].status, provider_ref: row[1].provider_ref }] : [];
    } else if (q.includes('SELECT COUNT(*) AS n FROM pending')) {
      rows = [{ n: this.pending.size }];
    } else if (q.includes('INSERT INTO pending')) {
      const [askRef, dedupeId, , created] = params as [string, string, number, number];
      void created;
      const status = q.includes("'failed'") ? 'failed' : 'pending';
      this.pending.set(`${askRef}|${dedupeId}`, { status, provider_ref: null });
    } else if (q.includes('UPDATE pending SET status')) {
      const [status, providerRef, askRef] = params as [string, string | null, string];
      for (const k of this.pending.keys())
        if (k.startsWith(`${askRef}|`)) this.pending.set(k, { status, provider_ref: providerRef });
    } else if (q.includes('SELECT MIN(expires_at)')) {
      rows = [{ next: null }];
    }
    return { toArray: () => rows as T[] };
  }
}

describe('TeamRelay delivery quota (lane 01M50ZQCTW)', () => {
  it('a team that spends its minute quota is refused without a provider call; the refusal is retryable', async () => {
    const credentialHash = 'f'.repeat(64);
    const sent: Record<string, unknown>[] = [];
    const socket = {
      deserializeAttachment: () => ({ slug: 'revive', credentialHash }),
      send: (raw: string) => sent.push(JSON.parse(raw) as Record<string, unknown>),
      close: vi.fn(),
    };
    const sql = new FakeSql();
    const state = {
      blockConcurrencyWhile: (fn: () => unknown) => fn(),
      storage: {
        sql,
        setAlarm: async () => {},
        deleteAlarm: async () => {},
      },
      getWebSockets: () => [socket],
      setWebSocketAutoResponse: vi.fn(),
      getWebSocketAutoResponseTimestamp: () => null,
    };
    const relay = new TeamRelay(
      state as unknown as DurableObjectState,
      {
        TEAM_CREDENTIALS_JSON: JSON.stringify({ revive: credentialHash }),
        TEAM_QUOTAS_JSON: JSON.stringify({ revive: { per_minute: 2, per_day: 100 } }),
      } as Env,
    );
    let providerCalls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        providerCalls += 1;
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );
    const deliver = (n: number) =>
      relay.webSocketMessage(
        socket as unknown as WebSocket,
        JSON.stringify({
          protocol: 1,
          type: 'deliver',
          ask_ref: `ask-${n}`,
          dedupe_id: `ask-${n}:slack:b1`,
          expires_at: Date.now() + 60_000,
          post: { url: 'https://provider.example/post', body: '{}' },
        }),
      );
    try {
      await deliver(1);
      await deliver(2);
      await deliver(3);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(providerCalls).toBe(2);
    expect(sent[0]).toMatchObject({ type: 'delivered', ask_ref: 'ask-1', ok: true });
    expect(sent[1]).toMatchObject({ type: 'delivered', ask_ref: 'ask-2', ok: true });
    expect(sent[2]).toMatchObject({
      type: 'delivered',
      ask_ref: 'ask-3',
      ok: false,
      reason: 'rate_limited',
    });
    // Stored failed, so the daemon's re-push takes the retry path, not a duplicate answer.
    expect(sql.pending.get('ask-3|ask-3:slack:b1')?.status).toBe('failed');
  });
});

describe('TeamRelay app half (ADR 676 §2, §9)', () => {
  it('a body fetch asks the daemon over the socket and hands back only what it answers', async () => {
    const { relay, sent } = await relayWithSocket();
    const res = await relay.fetch(new Request('https://relay.example/app/revive/body/b1/ask-1'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      team: 'revive',
      binding: 'b1',
      ref: 'ask-1',
      expires_at: 99,
      sealed: { v: 1, enc: 'e', ct: 'c' },
    });
    expect(sent[0]).toMatchObject({ type: 'app_fetch', ask_ref: 'ask-1', binding: 'b1' });
    const missing = await relay.fetch(new Request('https://relay.example/app/revive/body/b1/gone'));
    expect(missing.status).toBe(404);
  });

  it('an app_deliver is pushed to APNs and reported; without APNs config it is refused', async () => {
    const bare = await relayWithSocket();
    const frame = JSON.stringify({
      protocol: 1,
      type: 'app_deliver',
      ask_ref: 'ask-1',
      dedupe_id: 'ask-1:app:b1',
      expires_at: Date.now() + 60_000,
      binding: 'b1',
      push: { token: 'ab'.repeat(32), environment: 'production' },
      sealed: { v: 1, enc: 'e', ct: 'c' },
    });
    await bare.relay.webSocketMessage(bare.socket as unknown as WebSocket, frame);
    expect(bare.sent[0]).toMatchObject({
      type: 'error',
      reason: 'app push not configured on this relay',
    });

    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
    ])) as CryptoKeyPair;
    const der = new Uint8Array(
      (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
    );
    const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...der))}\n-----END PRIVATE KEY-----`;
    const configured = await relayWithSocket({
      APNS_KEY_P8: pem,
      APNS_KEY_ID: 'K',
      APNS_TEAM_ID: 'D27MJGWNY3',
      APNS_TOPIC: 'io.musterd.app',
    });
    const posted: { url: string; body: string }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        posted.push({ url, body: String(init.body) });
        return new Response(null, { status: 200, headers: { 'apns-id': 'apns-9' } });
      }),
    );
    try {
      await configured.relay.webSocketMessage(configured.socket as unknown as WebSocket, frame);
    } finally {
      vi.unstubAllGlobals();
    }
    expect(posted[0]!.url).toBe(`https://api.push.apple.com/3/device/${'ab'.repeat(32)}`);
    expect(JSON.parse(posted[0]!.body).musterd.sealed).toEqual({ v: 1, enc: 'e', ct: 'c' });
    expect(configured.sent[0]).toMatchObject({
      type: 'delivered',
      ask_ref: 'ask-1',
      ok: true,
      status: 200,
      provider_ref: 'apns-9',
    });
  });
});

describe('TeamRelay socket liveness (ADR 756)', () => {
  const callback = () =>
    new Request('https://relay.example/callback/revive/ask-1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"app":1}',
    });

  it('a socket that stopped pinging is closed and the callback refused 503, not 202', async () => {
    const { relay, socket, sent } = await relayWithSocket({}, new Date(Date.now() - 120_000));
    const res = await relay.fetch(callback());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('daemon socket silent');
    expect(socket.close).toHaveBeenCalledWith(1011, 'heartbeat silent');
    expect(sent).toEqual([]);
  });

  it('a socket that pinged within the window takes the callback', async () => {
    const { relay, socket, sent } = await relayWithSocket({}, new Date(Date.now() - 10_000));
    const res = await relay.fetch(callback());
    expect(res.status).toBe(202);
    expect(socket.close).not.toHaveBeenCalled();
    expect(sent[0]?.['type']).toBe('callback');
  });

  it('a socket that never pinged (a daemon before the heartbeat) keeps the ADR 659 rule', async () => {
    const { relay, sent } = await relayWithSocket({}, null);
    expect((await relay.fetch(callback())).status).toBe(202);
    expect(sent[0]?.['type']).toBe('callback');
  });
});
