import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { csrfTokenFor } from '../../../console/src/csrf.js';
import { createConsoleServer } from '../../../console/src/http.js';
import { makeLog } from '../../../console/src/log.js';
import { migrate } from '../../../console/src/schema.js';
import { createSession } from '../../../console/src/sessions.js';
import { pglite } from '../../../console/src/testing.js';
import { localSigner, signConsoleToken, type TokenSigner } from '../../../console/src/tokens.js';
import { bootCloud } from './testing.js';

/**
 * Increment 2's token tests against the console (spec §4.3, ADR 685). The server reaches the
 * console over HTTP. This file is the only place the two packages meet, and only in a test:
 * nothing at runtime imports `@musterd/console`.
 */

const ISSUER = 'http://127.0.0.1';
const AUD = 'https://cloud.test';
const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');

describe('console tokens against the console (ADR 685)', () => {
  let base = '';
  let jwksUrl = '';
  let sid = '';
  let signer: TokenSigner;
  let closeConsole: () => Promise<void> = async () => undefined;
  let cloud: Awaited<ReturnType<typeof bootCloud>>;

  beforeAll(async () => {
    const { db, q } = await pglite();
    await db.exec('CREATE ROLE console_app NOLOGIN');
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
    signer = localSigner();
    const server = createConsoleServer({
      config: {
        databaseUrl: 'postgres://x@db.test/console',
        issuer: ISSUER,
        allowedHosts: ['127.0.0.1'],
        host: '127.0.0.1',
        port: 0,
        build: null,
        providers: {},
        email: null,
        kms: null,
      },
      db: q,
      log: makeLog(() => undefined),
      signer,
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
    jwksUrl = `${base}/.well-known/jwks.json`;
    closeConsole = () => new Promise((r) => server.close(() => r()));
    cloud = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: jwksUrl });
  }, 60_000);

  afterAll(async () => {
    await cloud?.s.close();
    await closeConsole();
  });

  async function mint(aud: string): Promise<string> {
    const res = await fetch(`${base}/tokens`, {
      method: 'POST',
      headers: {
        origin: ISSUER,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `__Host-session=${sid}`,
      },
      body: new URLSearchParams({ aud, csrf: csrfTokenFor(sid) }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { token: string }).token;
  }

  function create(url: string, token: string) {
    return fetch(`${url}/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ slug: 'acme', creator: { name: 'ada' } }),
    });
  }

  async function reason(res: Response): Promise<string> {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? '';
  }

  it('refuses an expired token from this console', async () => {
    const { token } = await signConsoleToken(signer, {
      iss: ISSUER,
      sub: 'acct_1',
      aud: AUD,
      nowS: Math.floor(Date.now() / 1000) - 120,
    });
    const res = await create(cloud.url, token);
    expect(res.status).toBe(401);
    expect(await reason(res)).toMatch(/expired/);
  });

  it('refuses a token minted for another audience', async () => {
    const token = await mint('https://elsewhere.test');
    const res = await create(cloud.url, token);
    expect(res.status).toBe(401);
    expect(await reason(res)).toMatch(/wrong_audience/);
  });

  it('refuses alg none and HS256 keyed with the published JWK', async () => {
    const jwks = (await (await fetch(jwksUrl)).json()) as { keys: Record<string, unknown>[] };
    const kid = jwks.keys[0]?.['kid'];
    const claims = { sub: 'acct_1', aud: AUD, jti: 'j', exp: Math.floor(Date.now() / 1000) + 30 };
    const none = `${b64({ alg: 'none', kid })}.${b64(claims)}.`;
    const head = b64({ alg: 'HS256', kid });
    const body = b64(claims);
    const mac = createHmac('sha256', JSON.stringify(jwks.keys[0]))
      .update(`${head}.${body}`)
      .digest('base64url');
    const a = await create(cloud.url, none);
    const b = await create(cloud.url, `${head}.${body}.${mac}`);
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await reason(a)).toMatch(/bad_alg/);
    expect(await reason(b)).toMatch(/bad_alg/);
  });

  it('redeems one token on the first server and refuses the replay on the second', async () => {
    const token = await mint(AUD);
    const other = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: jwksUrl }, { fresh: false });
    try {
      const first = await create(cloud.url, token);
      expect(first.status).toBe(201);
      const second = await create(other.url, token);
      expect(second.status).toBe(401);
      expect(await reason(second)).toMatch(/replayed/);
    } finally {
      await other.s.close();
    }
  }, 60_000);
});
