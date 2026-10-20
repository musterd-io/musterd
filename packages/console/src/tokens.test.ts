import { createPublicKey, generateKeyPairSync, sign as cryptoSign, verify } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsoleConfig } from './config.js';
import { csrfTokenFor } from './csrf.js';
import { createConsoleServer } from './http.js';
import { makeLog } from './log.js';
import { migrate } from './schema.js';
import { FRESH_MS, createSession } from './sessions.js';
import { pglite } from './testing.js';
import { derToP1363, localSigner, signConsoleToken, TOKEN_LIFETIME_S } from './tokens.js';

const ISSUER = 'https://app.musterd.test';
const AUD = 'https://cloud.test';

function derOf(r: Buffer, s: Buffer): Buffer {
  const int = (b: Buffer) => {
    let body = b;
    while (body.length > 1 && body[0] === 0x00 && (body[1]! & 0x80) === 0) body = body.subarray(1);
    if (body[0]! & 0x80) body = Buffer.concat([Buffer.from([0x00]), body]);
    return Buffer.concat([Buffer.from([0x02, body.length]), body]);
  };
  const body = Buffer.concat([int(r), int(s)]);
  if (body.length > 127) throw new Error('test DER needs a long length');
  return Buffer.concat([Buffer.from([0x30, body.length]), body]);
}

describe('derToP1363', () => {
  it('strips the sign byte and left-pads each integer to 32 bytes', () => {
    const r = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(31, 0x11)]);
    const s = Buffer.concat([Buffer.from([0x01]), Buffer.alloc(31, 0x22)]);
    expect(derToP1363(derOf(r, s)).equals(Buffer.concat([r, s]))).toBe(true);
  });

  it('matches one node:crypto DER signature verified as ieee-p1363', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const msg = Buffer.from('header.payload');
    const der = cryptoSign('sha256', msg, privateKey);
    const raw = derToP1363(der);
    expect(raw).toHaveLength(64);
    expect(verify('sha256', msg, { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
  });

  it('rejects a value that is not one sequence of two integers', () => {
    expect(() => derToP1363(Buffer.from([0x30, 0x00]))).toThrow(/P-256 DER/);
    expect(() => derToP1363(Buffer.alloc(0))).toThrow(/P-256 DER/);
  });
});

describe('signConsoleToken', () => {
  it('publishes the key it signs with, 60 seconds, and refuses a bad audience', async () => {
    const signer = localSigner();
    const jwk = await signer.publicJwk();
    const nowS = 1_700_000_000;
    const { token, jti } = await signConsoleToken(signer, {
      iss: ISSUER,
      sub: 'acct_1',
      aud: AUD,
      nowS,
    });
    const [h, p, s] = token.split('.');
    expect(JSON.parse(Buffer.from(h!, 'base64url').toString())).toMatchObject({
      alg: 'ES256',
      kid: jwk.kid,
    });
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as {
      jti: string;
      exp: number;
      aud: string;
    };
    expect(claims.jti).toBe(jti);
    expect(claims.aud).toBe(AUD);
    expect(claims.exp).toBe(nowS + TOKEN_LIFETIME_S);
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        {
          key: createPublicKey({ key: jwk, format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(s!, 'base64url'),
      ),
    ).toBe(true);
    await expect(
      signConsoleToken(signer, { iss: ISSUER, sub: 'acct_1', aud: 'has space', nowS }),
    ).rejects.toThrow(/bad audience/);
  });
});

describe('POST /tokens (ADR 685)', () => {
  const lines: string[] = [];
  let port = 0;
  let sid = '';
  let close: () => Promise<void> = async () => undefined;
  let q: Awaited<ReturnType<typeof pglite>>['q'];
  const signer = localSigner();

  beforeAll(async () => {
    const db = await pglite();
    q = db.q;
    await db.db.exec('CREATE ROLE console_app NOLOGIN');
    await migrate(q, 'console_app');
    const t = Date.now();
    await q.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', ['acct_1', t]);
    sid = await createSession(
      q,
      {
        accountId: 'acct_1',
        method: 'email',
        identityProvider: 'email',
        identitySubject: 'ada@example.test',
      },
      t,
    );
    const config: ConsoleConfig = {
      databaseUrl: 'postgres://x@db.test/console',
      issuer: ISSUER,
      allowedHosts: ['app.musterd.test'],
      host: '127.0.0.1',
      port: 0,
      build: null,
      providers: {},
      email: null,
      kms: null,
    };
    const server = createConsoleServer({
      config,
      db: q,
      log: makeLog((l) => lines.push(l)),
      signer,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
    close = () => new Promise((r) => server.close(() => r()));
  });
  afterAll(() => close());

  function call(
    path: string,
    opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const r = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method: opts.method ?? 'GET',
            headers: { host: 'app.musterd.test', ...(opts.headers ?? {}) },
          },
          (res) => {
            let body = '';
            res.on('data', (c: Buffer) => (body += c.toString()));
            res.on('end', () =>
              resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
            );
          },
        );
        r.on('error', reject);
        if (opts.body) r.write(opts.body);
        r.end();
      },
    );
  }

  function post(aud: string, extra: Record<string, string> = {}, csrf = csrfTokenFor(sid)) {
    return call('/tokens', {
      method: 'POST',
      headers: {
        origin: ISSUER,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `__Host-session=${sid}`,
        ...extra,
      },
      body: new URLSearchParams({ aud, csrf }).toString(),
    });
  }

  it('publishes the signer on the JWKS and mints a token that verifies', async () => {
    const j = await call('/.well-known/jwks.json');
    expect(j.status).toBe(200);
    expect(j.headers['cache-control']).toBe('public, max-age=300');
    expect(JSON.parse(j.body)).toEqual({ keys: [await signer.publicJwk()] });
    const minted = await post(AUD);
    expect(minted.status).toBe(200);
    const { token } = JSON.parse(minted.body) as { token: string };
    const [h, p, s] = token.split('.');
    const jwk = await signer.publicJwk();
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        {
          key: createPublicKey({ key: jwk, format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(s!, 'base64url'),
      ),
    ).toBe(true);
    expect(lines.join('\n')).not.toContain(token);
    const audit = await q.query<{ action: string; detail: string }>(
      `SELECT action, detail FROM audit WHERE action = 'token.issue'`,
    );
    expect(audit.rows[0]?.action).toBe('token.issue');
    const detail = JSON.parse(audit.rows[0]!.detail) as { aud: string; jti: string };
    expect(detail.aud).toBe(AUD);
    expect(detail.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(audit.rows[0]!.detail).not.toContain(token);
  });

  it('refuses a missing session, a bad CSRF token, a stale sign-in, and a bad audience', async () => {
    const signedOut = await call('/tokens', {
      method: 'POST',
      headers: { origin: ISSUER, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ aud: AUD, csrf: 'nope' }).toString(),
    });
    expect(signedOut.status).toBe(401);
    const badCsrf = await post(AUD, {}, 'not-the-token');
    expect(badCsrf.status).toBe(403);
    expect(JSON.parse(badCsrf.body).error.code).toBe('forbidden');
    await q.query('UPDATE sessions SET authenticated_at = $1 WHERE account_id = $2', [
      Date.now() - FRESH_MS - 1_000,
      'acct_1',
    ]);
    const stale = await post(AUD);
    expect(stale.status).toBe(403);
    expect(JSON.parse(stale.body).error.code).toBe('stale');
    await q.query('UPDATE sessions SET authenticated_at = $1 WHERE account_id = $2', [
      Date.now(),
      'acct_1',
    ]);
    const badAud = await post('not a good audience');
    expect(badAud.status).toBe(400);
    expect(JSON.parse(badAud.body).error.code).toBe('bad_audience');
  });

  it('stops at 30 tokens a minute for the account', async () => {
    let last = 200;
    for (let i = 0; i < 40 && last === 200; i++) last = (await post(AUD)).status;
    expect(last).toBe(429);
    const blocked = await post(AUD);
    expect(blocked.status).toBe(429);
    expect(blocked.headers['retry-after']).toBe('60');
  });
});

describe('POST /tokens with no signer', () => {
  it('is 404, and a GET is 405', async () => {
    const config: ConsoleConfig = {
      databaseUrl: 'postgres://x@db.test/console',
      issuer: ISSUER,
      allowedHosts: ['app.musterd.test'],
      host: '127.0.0.1',
      port: 0,
      build: null,
      providers: {},
      email: null,
      kms: null,
    };
    const server = createConsoleServer({
      config,
      db: { query: async () => ({ rows: [] }) },
      log: makeLog(() => undefined),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const p = (server.address() as AddressInfo).port;
    const once = (method: string) =>
      new Promise<number>((resolve, reject) => {
        const r = request(
          {
            host: '127.0.0.1',
            port: p,
            path: '/tokens',
            method,
            headers: {
              host: 'app.musterd.test',
              origin: ISSUER,
              'content-type': 'application/x-www-form-urlencoded',
            },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        r.on('error', reject);
        if (method === 'POST') r.write('aud=x&csrf=y');
        r.end();
      });
    expect(await once('POST')).toBe(404);
    expect(await once('GET')).toBe(405);
    await new Promise<void>((r) => server.close(() => r()));
  });
});
