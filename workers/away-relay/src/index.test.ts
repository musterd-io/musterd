import { describe, expect, it, vi } from 'vitest';
import worker, { TeamRelay, type Env } from './index.js';

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
  const forwarded = vi.fn(async () => new Response('forwarded', { status: 200 }));
  const full = {
    AWAY_RELAY: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: forwarded }),
    },
    ...partial,
  } as unknown as Env;
  return { env: full, forwarded };
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
async function relayWithSocket(extraEnv: Partial<Env> = {}) {
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
