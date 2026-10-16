import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { blockListOf } from './clientip.js';
import type { ConsoleConfig } from './config.js';
import type { SignInEmail } from './email.js';
import { createConsoleServer, inboxKey } from './http.js';
import { makeLog } from './log.js';
import { migrate } from './schema.js';
import { pglite } from './testing.js';

/** ADR 620 decision 6 over HTTP: magic links, same-browser only, never signing in on a GET. */
const ISSUER = 'https://app.musterd.test';
let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});

async function boot(opts: { email?: boolean; failSend?: boolean } = {}) {
  const { db, q } = await pglite();
  await db.exec('CREATE ROLE console_app NOLOGIN');
  await migrate(q, 'console_app');
  const sent: SignInEmail[] = [];
  const lines: string[] = [];
  const config: ConsoleConfig = {
    databaseUrl: 'postgres://x@db.test/console',
    issuer: ISSUER,
    allowedHosts: ['app.musterd.test'],
    host: '127.0.0.1',
    port: 0,
    build: null,
    providers: {},
    email:
      opts.email === false
        ? null
        : {
            accountId: 'acct',
            apiToken: 'cf-token-secret',
            fromAddress: 'signin@musterd.test',
            fromName: 'musterd',
          },
  };
  const server = createConsoleServer({
    config,
    db: q,
    log: makeLog((l) => lines.push(l)),
    clientIp: { behindFlyProxy: false, trustedProxies: blockListOf(['127.0.0.1/32', '::1/128']) },
    sendEmail: async (_cfg, m) => {
      sent.push(m);
      return !opts.failSend;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  closers.push(() => new Promise((r) => server.close(() => r())));
  const port = (server.address() as AddressInfo).port;
  const call = (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: string,
  ) =>
    new Promise<{
      status: number;
      headers: Record<string, string | string[] | undefined>;
      body: string;
    }>((resolve, reject) => {
      const r = request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers: { host: 'app.musterd.test', ...headers },
        },
        (res) => {
          let b = '';
          res.on('data', (c: Buffer) => (b += c.toString()));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }),
          );
        },
      );
      r.on('error', reject);
      r.end(body);
    });
  const cookieOf = (h: string | string[] | undefined, name: string) => {
    for (const c of Array.isArray(h) ? h : h ? [h] : []) {
      const m = new RegExp(`^${name}=([^;]*)`).exec(c);
      if (m) return m[1]!;
    }
    return undefined;
  };
  const form = (extra: Record<string, string> = {}) => ({
    origin: ISSUER,
    'content-type': 'application/x-www-form-urlencoded',
    ...extra,
  });
  const ask = async (email = 'Nick@Example.TEST', ip = '203.0.113.1') => {
    const r = await call(
      'POST',
      '/auth/email/start',
      form({ 'cf-connecting-ip': ip }),
      `email=${encodeURIComponent(email)}&return=%2Faccount`,
    );
    const link = sent.at(-1)?.link;
    return {
      r,
      tx: cookieOf(r.headers['set-cookie'], '__Host-tx'),
      token: link ? new URL(link).searchParams.get('t')! : '',
    };
  };
  const view = (token: string, tx?: string) =>
    call('GET', `/auth/email/confirm?t=${token}`, tx ? { cookie: `__Host-tx=${tx}` } : {});
  const confirm = (token: string, tx?: string) =>
    call(
      'POST',
      '/auth/email/confirm',
      form(tx ? { cookie: `__Host-tx=${tx}` } : {}),
      `t=${token}`,
    );
  return { q, call, ask, view, confirm, sent, lines, cookieOf };
}

describe('magic links (ADR 620 decision 6)', () => {
  it('sends a link built from the pinned issuer, sets the browser binding, answers "check email"', async () => {
    const { ask, sent } = await boot();
    const { r, tx, token } = await ask();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, state: 'check_email' });
    expect(tx).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(sent[0]!.to).toBe('Nick@example.test');
    expect(sent[0]!.link).toBe(`${ISSUER}/auth/email/confirm?t=${token}`);
    expect(sent[0]!.expiresMinutes).toBe(15);
  });

  it('a GET of the link never consumes it: a scanner can follow it any number of times', async () => {
    const { ask, view, confirm } = await boot();
    const { tx, token } = await ask();
    for (let i = 0; i < 3; i++)
      expect(JSON.parse((await view(token)).body).state).toBe('other_browser');
    expect(JSON.parse((await view(token, tx)).body).state).toBe('confirm');
    expect((await confirm(token, tx)).status).toBe(303);
  });

  it('the asking browser confirms and is signed in; the link then works never again', async () => {
    const { ask, confirm, call, cookieOf, view } = await boot();
    const { tx, token } = await ask();
    const c = await confirm(token, tx);
    expect(c.status).toBe(303);
    expect(c.headers['location']).toBe('/account');
    const sid = cookieOf(c.headers['set-cookie'], '__Host-session')!;
    const me = JSON.parse((await call('GET', '/me', { cookie: `__Host-session=${sid}` })).body);
    expect(me.methods).toEqual([{ provider: 'email', email: 'Nick@example.test' }]);
    expect((await confirm(token, tx)).status).toBe(400);
    expect(JSON.parse((await view(token, tx)).body).state).toBe('expired');
  });

  it('another browser — or no browser binding — cannot use the link', async () => {
    const { ask, confirm } = await boot();
    const a = await ask();
    const b = await ask('someone@example.test', '198.51.100.2');
    expect((await confirm(a.token)).status).toBe(400);
    expect((await confirm(a.token, b.tx)).status).toBe(400);
    expect((await confirm(a.token, a.tx)).status).toBe(303);
  });

  it('an expired link is refused', async () => {
    const { ask, confirm, q } = await boot();
    const { tx, token } = await ask();
    await q.query("UPDATE auth_transactions SET expires_at = 1 WHERE kind = 'magic'", []);
    expect((await confirm(token, tx)).status).toBe(400);
  });

  it('the same address is one account; the domain is case-folded, the local part is not', async () => {
    const { ask, confirm, call, cookieOf } = await boot();
    const who = async (email: string, ip: string) => {
      const a = await ask(email, ip);
      const c = await confirm(a.token, a.tx);
      return JSON.parse(
        (
          await call('GET', '/me', {
            cookie: `__Host-session=${cookieOf(c.headers['set-cookie'], '__Host-session')}`,
          })
        ).body,
      ).account_id;
    };
    const one = await who('Nick@Example.TEST', '203.0.113.10');
    expect(await who('Nick@example.test', '203.0.113.11')).toBe(one);
    expect(await who('nick@example.test', '203.0.113.12')).not.toBe(one);
  });

  it("limits per client and per address, and one client's limit does not block another", async () => {
    const { ask } = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++)
      statuses.push((await ask(`p${i}@example.test`, '203.0.113.50')).r.status);
    expect(statuses).toEqual([200, 200, 200, 200, 200, 429]);
    expect((await ask('fresh@example.test', '203.0.113.51')).r.status).toBe(200);
    // One client cannot bomb an inbox: 5 an hour per address from one client.
    const sameClient: number[] = [];
    for (let i = 0; i < 6; i++)
      sameClient.push((await ask('victim@example.test', '198.51.100.60')).r.status);
    expect(sameClient.at(-1)).toBe(429);
    // Many clients are bounded at 20 an hour for one address.
    const many: number[] = [];
    for (let i = 0; i < 16; i++)
      many.push((await ask('victim@example.test', `198.51.100.${70 + i}`)).r.status);
    expect(many.slice(0, 15).every((x) => x === 200)).toBe(true);
    expect(many[15]).toBe(429);
    // Another address is unaffected.
    expect((await ask('bystander@example.test', '198.51.100.99')).r.status).toBe(200);
  });

  it('the send volume is watched, never a gate: no global switch to lock everyone out', async () => {
    const { ask, q } = await boot();
    await q.query(
      "INSERT INTO rate_limits (bucket, window_start, count) VALUES ('email-send-watch', $1, 100000)",
      [Date.now() - (Date.now() % (60 * 60 * 1000))],
    );
    expect((await ask('anyone@example.test', '203.0.113.77')).r.status).toBe(200);
  });

  it('refuses a malformed address, a foreign Origin, and is off without a sender', async () => {
    const { call } = await boot();
    const form = { origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' };
    for (const bad of ['', 'nick', 'a@b', 'a@@b.test', 'a b@c.test', 'x@y.test\r\nBcc: z@w.test'])
      expect(
        (await call('POST', '/auth/email/start', form, `email=${encodeURIComponent(bad)}`)).status,
        bad,
      ).toBe(400);
    expect(
      (
        await call(
          'POST',
          '/auth/email/start',
          { ...form, origin: 'https://evil.test' },
          'email=a%40b.test',
        )
      ).status,
    ).toBe(403);
    const off = await boot({ email: false });
    expect((await off.call('POST', '/auth/email/start', form, 'email=a%40b.test')).status).toBe(
      404,
    );
  });

  it('a failed send still answers "check email" and leaks nothing about the address', async () => {
    const { ask } = await boot({ failSend: true });
    const { r } = await ask();
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body)).toEqual({ ok: true, state: 'check_email' });
  });

  it('no token, link, address, tx cookie or session id reaches the log or the audit', async () => {
    const { ask, confirm, lines, q, cookieOf } = await boot();
    const a = await ask('leaky@example.test');
    const c = await confirm(a.token, a.tx);
    const sid = cookieOf(c.headers['set-cookie'], '__Host-session')!;
    await confirm('x'.repeat(43), a.tx);
    const audit = (await q.query<{ detail: string }>('SELECT detail FROM audit', [])).rows
      .map((r) => r.detail)
      .join('\n');
    for (const leak of [a.token, a.tx!, sid, 'leaky@example.test', 'cf-token-secret'])
      for (const [where, text] of [
        ['log', lines.join('\n')],
        ['audit', audit],
      ] as const)
        expect(text, `${where}: ${leak.slice(0, 8)}`).not.toContain(leak);
  });

  it('counts every spelling that reaches one inbox as that inbox', async () => {
    expect(inboxKey('Nick+promo@Example.TEST')).toBe('nick@example.test');
    expect(inboxKey('n.i.c.k+x@googlemail.com')).toBe('nick@gmail.com');
    expect(inboxKey('n.ick@other.test')).toBe('n.ick@other.test');
    const { ask } = await boot();
    const spellings = ['Victim', 'VICTIM', 'victim+1', 'victim+2', 'victim+3', 'victim+4'];
    const statuses: number[] = [];
    for (const local of spellings)
      statuses.push((await ask(`${local}@example.test`, '198.51.100.20')).r.status);
    expect(statuses.at(-1)).toBe(429);
  });
});
