import { describe, expect, it, vi } from 'vitest';
import {
  GLOBAL_MS,
  PER_VIEWER_MS,
  chatCredsFromEnv,
  makeChatGate,
  parseWho,
  spotlightExpression,
  startChatReader,
  type ChatSocket,
} from './twitchChat.js';

describe('parseWho', () => {
  it('takes `!who <name>` and nothing else', () => {
    expect(parseWho('!who slippy')).toBe('slippy');
    expect(parseWho('  !WHO   @Big-Body ')).toBe('Big-Body');
    expect(parseWho('!who')).toBeNull();
    expect(parseWho('!who a b')).toBeNull();
    expect(parseWho('!who x");alert(1)//')).toBeNull();
    expect(parseWho('!who ' + 'a'.repeat(33))).toBeNull();
    expect(parseWho('!run slippy')).toBeNull();
    expect(parseWho('hey !who slippy')).toBeNull();
  });
});

describe('makeChatGate', () => {
  it('drops over the global and the per-viewer limits, never queues', () => {
    let t = 0;
    const gate = makeChatGate(() => t);
    expect(gate('a')).toBe(true);
    expect(gate('b')).toBe(false); // global
    t += GLOBAL_MS;
    expect(gate('a')).toBe(false); // per viewer
    expect(gate('b')).toBe(true);
    t += PER_VIEWER_MS;
    expect(gate('a')).toBe(true);
  });
});

describe('chatCredsFromEnv', () => {
  it('is off unless all four are set', () => {
    const full = {
      MUSTERD_TWITCH_CHAT_CLIENT_ID: 'c',
      MUSTERD_TWITCH_CHAT_CLIENT_SECRET: 's',
      MUSTERD_TWITCH_CHAT_REFRESH_TOKEN: 'r',
      MUSTERD_TWITCH_CHAT_CHANNEL: 'musterd',
    };
    expect(chatCredsFromEnv(full)).toEqual({
      clientId: 'c',
      clientSecret: 's',
      refreshToken: 'r',
      channel: 'musterd',
    });
    expect(chatCredsFromEnv({ ...full, MUSTERD_TWITCH_CHAT_CHANNEL: ' ' })).toBeNull();
  });
});

it('spotlightExpression quotes the name', () => {
  expect(spotlightExpression('slippy')).toBe('void window.__office?.spotlight?.("slippy")');
});

function harness() {
  const sockets: (ChatSocket & { url: string; closed: boolean; send: (f: unknown) => void })[] = [];
  const connect = (url: string) => {
    const s = {
      url,
      closed: false,
      onmessage: null as ChatSocket['onmessage'],
      onclose: null as ChatSocket['onclose'],
      close() {
        if (s.closed) return;
        s.closed = true;
        s.onclose?.();
      },
      send(f: unknown) {
        s.onmessage?.({ data: JSON.stringify(f) });
      },
    };
    sockets.push(s);
    return s;
  };
  const calls: string[] = [];
  const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? 'GET'} ${u}`);
    if (u.includes('oauth2/token')) return Response.json({ access_token: 'tok' });
    if (u.includes('/users?login=')) return Response.json({ data: [{ id: 'B' }] });
    if (u.endsWith('/users')) return Response.json({ data: [{ id: 'BOT' }] });
    if (u.includes('/eventsub/subscriptions')) return new Response(null, { status: 202 });
    return new Response(null, { status: 404 });
  });
  const who: string[] = [];
  const logs: string[] = [];
  let t = 0;
  const stop = startChatReader({
    creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r', channel: 'musterd' },
    onWho: (n) => who.push(n),
    log: (l) => logs.push(l),
    fetch: fetchFn as unknown as typeof fetch,
    connect,
    now: () => (t += GLOBAL_MS + PER_VIEWER_MS),
    backoffMs: 0,
  });
  return { sockets, calls, fetchFn, who, logs, stop };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const msg = (login: string, text: string) => ({
  metadata: { message_type: 'notification' },
  payload: { event: { chatter_user_login: login, message: { text } } },
});

describe('startChatReader', () => {
  it('subscribes on welcome and hands accepted names to the page only', async () => {
    const h = harness();
    h.sockets[0]!.send({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 'S' } },
    });
    await flush();
    await flush();
    const sub = h.fetchFn.mock.calls.find(([u]) => String(u).includes('eventsub'));
    expect(JSON.parse(String(sub![1]!.body))).toMatchObject({
      type: 'channel.chat.message',
      condition: { broadcaster_user_id: 'B', user_id: 'BOT' },
      transport: { method: 'websocket', session_id: 'S' },
    });
    h.sockets[0]!.send({ metadata: { message_type: 'session_keepalive' } });
    h.sockets[0]!.send(msg('viewer', '!who slippy'));
    h.sockets[0]!.send(msg('viewer2', 'hello'));
    expect(h.who).toEqual(['slippy']);
    expect(h.logs.join('\n')).not.toMatch(/tok|viewer|hello/);
    h.stop();
  });

  it('follows a reconnect without subscribing again', async () => {
    const h = harness();
    h.sockets[0]!.send({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 'S' } },
    });
    await flush();
    await flush();
    const subs = () => h.calls.filter((c) => c.includes('eventsub')).length;
    expect(subs()).toBe(1);
    h.sockets[0]!.send({
      metadata: { message_type: 'session_reconnect' },
      payload: { session: { reconnect_url: 'wss://next' } },
    });
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.sockets[1]!.url).toBe('wss://next');
    h.sockets[1]!.send({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 'S2' } },
    });
    await flush();
    expect(subs()).toBe(1);
    h.sockets[1]!.send(msg('v', '!who ghost'));
    expect(h.who).toEqual(['ghost']);
    h.stop();
  });

  it('reconnects after a drop, and stays off after a revocation', async () => {
    const h = harness();
    h.sockets[0]!.close();
    await new Promise((r) => setTimeout(r, 5));
    expect(h.sockets).toHaveLength(2);
    h.sockets[1]!.send({
      metadata: { message_type: 'revocation' },
      payload: { subscription: { status: 'authorization_revoked' } },
    });
    expect(h.sockets[1]!.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 5));
    expect(h.sockets).toHaveLength(2);
    expect(h.logs.at(-1)).toMatch(/off — subscription revoked/);
  });
});

it('keeps a rotated refresh token for the run and says so once, without the token', async () => {
  const sent: string[] = [];
  let n = 0;
  const fetchFn = async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('oauth2/token')) {
      sent.push(new URLSearchParams(String(init?.body)).get('refresh_token') ?? '');
      n += 1;
      return Response.json({ access_token: `tok${n}`, refresh_token: 'r2' });
    }
    if (u.includes('/users?login=')) {
      // the first lookup is refused, forcing a second refresh
      return n === 1 ? new Response(null, { status: 401 }) : Response.json({ data: [{ id: 'B' }] });
    }
    if (u.endsWith('/users')) return Response.json({ data: [{ id: 'BOT' }] });
    return new Response(null, { status: 202 });
  };
  const logs: string[] = [];
  let sock: ChatSocket | undefined;
  const stop = startChatReader({
    creds: { clientId: 'c', clientSecret: 's', refreshToken: 'r1', channel: 'musterd' },
    onWho: () => undefined,
    log: (l) => logs.push(l),
    fetch: fetchFn as unknown as typeof fetch,
    connect: () => (sock = { onmessage: null, onclose: null, close: () => undefined }),
  });
  sock!.onmessage?.({
    data: JSON.stringify({
      metadata: { message_type: 'session_welcome' },
      payload: { session: { id: 'S' } },
    }),
  });
  for (let i = 0; i < 10; i++) await new Promise((r) => setTimeout(r, 0));
  expect(sent).toEqual(['r1', 'r2']);
  expect(logs.filter((l) => l.includes('rotated'))).toHaveLength(1);
  expect(logs.join('\n')).not.toMatch(/\br2\b|tok\d/);
  stop();
});
