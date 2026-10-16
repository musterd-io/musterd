import { createSign, generateKeyPairSync } from 'node:crypto';
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { blockListOf } from './clientip.js';
import type { ConsoleConfig } from './config.js';
import { createConsoleServer } from './http.js';
import { makeLog } from './log.js';
import { migrate } from './schema.js';
import { pglite } from './testing.js';

/**
 * ADR 620 decisions 3–5 over HTTP, against a fake GitHub and a fake Google on 127.0.0.1. The fake
 * Google signs real RS256 ID tokens with a key it publishes as a JWKS, so `openid-client` verifies
 * signature, issuer, audience, expiry and nonce exactly as it will against Google.
 */
const ISSUER = 'https://app.musterd.test';
const creds = { clientId: 'console-client', clientSecret: 'client-secret-xyz' };
let closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of closers.reverse()) await c();
  closers = [];
});

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');

async function fakeProviders() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = {
    ...(publicKey.export({ format: 'jwk' }) as object),
    kid: 'k1',
    alg: 'RS256',
    use: 'sig',
  };
  const state = {
    nonce: '',
    googleSub: 'g-sub-1',
    githubId: 42 as number | string,
    email: 'nick@example.test',
  };
  let base = '';
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', base);
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const form = new URLSearchParams(body);
      const json = (o: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(o));
      };
      if (url.pathname === '/gh/token') {
        if (form.get('code') !== 'good-code' || !form.get('code_verifier'))
          return json({ error: 'bad_verification_code' }, 400);
        return json({ access_token: 'gho_faketoken', token_type: 'bearer', scope: '' });
      }
      if (url.pathname === '/gh/user') return json({ id: state.githubId, login: 'nick' });
      if (url.pathname === '/google/jwks') return json({ keys: [jwk] });
      if (url.pathname === '/google/token') {
        if (form.get('code') !== 'good-code' || !form.get('code_verifier'))
          return json({ error: 'invalid_grant' }, 400);
        const now = Math.floor(Date.now() / 1000);
        const head = b64({ alg: 'RS256', typ: 'JWT', kid: 'k1' });
        const payload = b64({
          iss: base,
          aud: creds.clientId,
          sub: state.googleSub,
          nonce: state.nonce,
          iat: now,
          exp: now + 300,
          email: state.email,
          email_verified: true,
        });
        const sig = createSign('RSA-SHA256')
          .update(`${head}.${payload}`)
          .sign(privateKey)
          .toString('base64url');
        return json({
          access_token: 'ya29.fake',
          token_type: 'Bearer',
          expires_in: 300,
          id_token: `${head}.${payload}.${sig}`,
        });
      }
      json({ error: 'not_found' }, 404);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  closers.push(() => new Promise((r) => server.close(() => r())));
  return {
    state,
    overrides: {
      insecure: true,
      endpoints: {
        github: {
          issuer: base,
          authorization_endpoint: `${base}/gh/authorize`,
          token_endpoint: `${base}/gh/token`,
          user_endpoint: `${base}/gh/user`,
        },
        google: {
          issuer: base,
          authorization_endpoint: `${base}/google/authorize`,
          token_endpoint: `${base}/google/token`,
          jwks_uri: `${base}/google/jwks`,
        },
      },
    },
  };
}

async function boot(opts: { providers?: ConsoleConfig['providers'] } = {}) {
  const fake = await fakeProviders();
  const { db, q } = await pglite();
  await db.exec('CREATE ROLE console_app NOLOGIN');
  await migrate(q, 'console_app');
  const lines: string[] = [];
  const config: ConsoleConfig = {
    databaseUrl: 'postgres://x@db.test/console',
    issuer: ISSUER,
    allowedHosts: ['app.musterd.test'],
    host: '127.0.0.1',
    port: 0,
    build: null,
    providers: opts.providers ?? { github: creds, google: creds },
    email: null,
  };
  const server = createConsoleServer({
    config,
    db: q,
    log: makeLog((l) => lines.push(l)),
    providers: fake.overrides,
    // The test client plays Cloudflare: its cf-connecting-ip is believed from the loopback.
    clientIp: { behindFlyProxy: false, trustedProxies: blockListOf(['127.0.0.1/32', '::1/128']) },
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
  const cookieFrom = (h: string | string[] | undefined, name: string) => {
    const all = Array.isArray(h) ? h : h ? [h] : [];
    for (const c of all) {
      const m = new RegExp(`^${name}=([^;]*)`).exec(c);
      if (m) return m[1]!;
    }
    return undefined;
  };
  const start = async (provider: 'github' | 'google', returnPath = '/account') => {
    const r = await call(
      'POST',
      `/auth/${provider}/start`,
      {
        origin: ISSUER,
        'content-type': 'application/x-www-form-urlencoded',
      },
      `return=${encodeURIComponent(returnPath)}`,
    );
    const loc = new URL(String(r.headers['location']));
    if (provider === 'google') fake.state.nonce = loc.searchParams.get('nonce') ?? '';
    return {
      r,
      loc,
      tx: cookieFrom(r.headers['set-cookie'], '__Host-tx')!,
      state: loc.searchParams.get('state')!,
    };
  };
  const callback = (provider: string, query: string, tx?: string) =>
    call('GET', `/auth/${provider}/callback?${query}`, tx ? { cookie: `__Host-tx=${tx}` } : {});
  const signIn = async (provider: 'github' | 'google') => {
    const s = await start(provider);
    const cb = await callback(provider, `code=good-code&state=${s.state}`, s.tx);
    return { s, cb, sid: cookieFrom(cb.headers['set-cookie'], '__Host-session') };
  };
  const me = async (sid: string) =>
    JSON.parse((await call('GET', '/me', { cookie: `__Host-session=${sid}` })).body);
  return { q, call, start, callback, signIn, me, lines, fake };
}

describe('GitHub and Google sign-in (ADR 620)', () => {
  it('start: pinned callback, PKCE S256, state, a transaction cookie; Google adds a nonce', async () => {
    const { start } = await boot();
    const gh = await start('github');
    expect(gh.r.status).toBe(303);
    expect(gh.loc.searchParams.get('redirect_uri')).toBe(`${ISSUER}/auth/github/callback`);
    expect(gh.loc.searchParams.get('code_challenge_method')).toBe('S256');
    expect(gh.loc.searchParams.get('state')).toBeTruthy();
    expect(gh.loc.searchParams.get('nonce')).toBeNull();
    expect(String(gh.r.headers['set-cookie'])).toMatch(
      /^__Host-tx=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600/,
    );
    const g = await start('google');
    expect(g.loc.searchParams.get('nonce')).toBeTruthy();
    expect(g.loc.searchParams.get('scope')).toBe('openid email');
  });

  it('GitHub: signs in, lands on the allowed return path, and /me shows the account', async () => {
    const { signIn, me } = await boot();
    const { cb, sid } = await signIn('github');
    expect(cb.status).toBe(303);
    expect(cb.headers['location']).toBe('/account');
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const who = await me(sid!);
    expect(who.method).toBe('github');
    expect(who.methods).toEqual([{ provider: 'github', email: null }]);
  });

  it('Google: verifies the signed ID token and its nonce, and signs in', async () => {
    const { signIn, me } = await boot();
    const { cb, sid } = await signIn('google');
    expect(cb.status).toBe(303);
    const who = await me(sid!);
    expect(who.methods).toEqual([{ provider: 'google', email: 'nick@example.test' }]);
  });

  it('a Google ID token with the wrong nonce is refused', async () => {
    const { start, callback, fake } = await boot();
    const s = await start('google');
    fake.state.nonce = 'not-the-nonce';
    const cb = await callback('google', `code=good-code&state=${s.state}`, s.tx);
    expect(cb.status).toBe(400);
    expect(JSON.parse(cb.body).error.code).toBe('provider_refused');
  });

  it('the same identity twice is one account; another provider is another account, even with the same email', async () => {
    const { signIn, me } = await boot();
    const a = await me((await signIn('github')).sid!);
    const b = await me((await signIn('github')).sid!);
    const c = await me((await signIn('google')).sid!);
    expect(a.account_id).toBe(b.account_id);
    expect(c.account_id).not.toBe(a.account_id);
  });

  it('a transaction is single-use, bound to its cookie, its state and its provider', async () => {
    const { start, callback } = await boot();
    const s = await start('github');
    expect((await callback('github', `code=good-code&state=${s.state}`)).status).toBe(400);
    expect((await callback('github', `code=good-code&state=wrong`, s.tx)).status).toBe(400);
    const s2 = await start('github');
    expect((await callback('google', `code=good-code&state=${s2.state}`, s2.tx)).status).toBe(400);
    const s3 = await start('github');
    expect((await callback('github', `code=good-code&state=${s3.state}`, s3.tx)).status).toBe(303);
    const replay = await callback('github', `code=good-code&state=${s3.state}`, s3.tx);
    expect(replay.status).toBe(400);
    expect(JSON.parse(replay.body).error.code).toBe('signin_expired');
  });

  it('a provider error or a bad code is "provider refused", never a redirect', async () => {
    const { start, callback } = await boot();
    const s = await start('github');
    const denied = await callback('github', `error=access_denied&state=${s.state}`, s.tx);
    expect(denied.status).toBe(400);
    expect(denied.headers['location']).toBeUndefined();
    const s2 = await start('github');
    expect((await callback('github', `code=bad-code&state=${s2.state}`, s2.tx)).status).toBe(400);
  });

  it('an unlisted return path becomes /', async () => {
    const { start, callback } = await boot();
    for (const bad of [
      'https://evil.test/',
      '//evil.test',
      '/\\evil.test',
      '/%2F%2Fevil.test',
      '/account?x=1',
    ]) {
      const s = await start('github', bad);
      const cb = await callback('github', `code=good-code&state=${s.state}`, s.tx);
      expect(cb.headers['location'], bad).toBe('/');
    }
  });

  it('a disabled account cannot sign in', async () => {
    const { signIn, me, q } = await boot();
    const who = await me((await signIn('github')).sid!);
    await q.query('UPDATE accounts SET disabled_at = 1 WHERE id = $1', [who.account_id]);
    const again = await signIn('github');
    expect(again.cb.status).toBe(403);
    expect(again.sid).toBeUndefined();
  });

  it('an unconfigured provider does not exist; start needs the exact Origin', async () => {
    const { call } = await boot({ providers: { github: creds } });
    const form = { 'content-type': 'application/x-www-form-urlencoded' };
    expect((await call('POST', '/auth/google/start', { origin: ISSUER, ...form }, '')).status).toBe(
      404,
    );
    expect((await call('GET', '/auth/google/callback?code=x&state=y')).status).toBe(404);
    expect(
      (await call('POST', '/auth/github/start', { origin: 'https://evil.test', ...form }, ''))
        .status,
    ).toBe(403);
    expect((await call('GET', '/auth/github/start')).status).toBe(405);
  });

  it('one client hitting its limit does not lock out another (no global bucket)', async () => {
    const { call } = await boot();
    const form = { origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' };
    const a = { ...form, 'cf-connecting-ip': '203.0.113.1' };
    const statuses: number[] = [];
    for (let i = 0; i < 31; i++)
      statuses.push((await call('POST', '/auth/github/start', a, '')).status);
    expect(statuses.slice(0, 30).every((s) => s === 303)).toBe(true);
    expect(statuses[30]).toBe(429);
    const b = { ...form, 'cf-connecting-ip': '198.51.100.7' };
    expect((await call('POST', '/auth/github/start', b, '')).status).toBe(303);
  });

  it('no code, state, token, transaction cookie or session id reaches the log or the audit', async () => {
    const { signIn, start, callback, lines, q } = await boot();
    const { s, sid } = await signIn('github');
    const s2 = await start('github');
    await callback('github', `code=bad-code&state=${s2.state}`, s2.tx);
    const audit = (await q.query<{ detail: string }>('SELECT detail FROM audit', [])).rows
      .map((r) => r.detail)
      .join('\n');
    for (const leak of [
      'good-code',
      'bad-code',
      s.state,
      s.tx,
      s2.tx,
      sid!,
      'gho_faketoken',
      'client-secret-xyz',
    ])
      for (const [where, text] of [
        ['log', lines.join('\n')],
        ['audit', audit],
      ] as const)
        expect(text, `${where}: ${leak.slice(0, 8)}`).not.toContain(leak);
  });
});
