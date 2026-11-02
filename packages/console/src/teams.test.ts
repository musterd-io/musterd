import { createPublicKey, verify } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsoleConfig } from './config.js';
import { resolveConsoleConfig } from './config.js';
import { csrfTokenFor } from './csrf.js';
import { createConsoleServer } from './http.js';
import { makeLog } from './log.js';
import { migrate } from './schema.js';
import { createSession } from './sessions.js';
import { pglite } from './testing.js';
import { localSigner } from './tokens.js';

const ISSUER = 'https://app.musterd.test';

/**
 * Create a team from the console (Cloud spec §4.3, lane 01M3Z44MTV). The console mints a token for
 * the team servers' audience, POSTs it to the new team's host, and shows the answer's secrets once.
 */
describe('POST /teams', () => {
  const lines: string[] = [];
  let port = 0;
  let sid = '';
  let close: () => Promise<void> = async () => undefined;
  let q: Awaited<ReturnType<typeof pglite>>['q'];
  const signer = localSigner();
  /** The fake team server: records what it was sent, answers what the test scripted. */
  const seen: { url: string; auth: string | undefined; body: unknown }[] = [];
  let answer: { status: number; body: unknown } | (() => never) = { status: 201, body: {} };

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
      teams: { suffix: 'musterd.test', audience: 'https://musterd.test' },
    };
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({
        url: String(url),
        auth: (init?.headers as Record<string, string> | undefined)?.['authorization'],
        body: JSON.parse(String(init?.body)),
      });
      if (typeof answer === 'function') answer();
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    const server = createConsoleServer({
      config,
      db: q,
      log: makeLog((l) => lines.push(l)),
      signer,
      fetch: fakeFetch,
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

  function post(fields: Record<string, string>, csrf = csrfTokenFor(sid), cookie = sid) {
    return call('/teams', {
      method: 'POST',
      headers: {
        origin: ISSUER,
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `__Host-session=${cookie}`,
      },
      body: new URLSearchParams({ ...fields, csrf }).toString(),
    });
  }

  it('the account page carries the form, naming the host the team will get', async () => {
    const r = await call('/account', { headers: { cookie: `__Host-session=${sid}` } });
    expect(r.status).toBe(200);
    expect(r.body).toContain('Create a team');
    expect(r.body).toContain('action="/teams"');
    expect(r.body).toContain('name.musterd.test');
  });

  it('mints a token for the team audience, posts it to the new host, and shows the secrets once', async () => {
    answer = {
      status: 201,
      body: {
        team: { id: 't1', slug: 'acme', display: 'Acme' },
        human_credential: 'mscr_SHOWN_ONCE',
        agent_key: 'mskey_SHOWN_ONCE',
      },
    };
    const r = await post({ slug: 'Acme', display: 'Acme', name: 'ada' });
    expect(r.status).toBe(200);
    expect(r.body).toContain('Team created');
    expect(r.body).toContain('mscr_SHOWN_ONCE');
    expect(r.body).toContain('mskey_SHOWN_ONCE');
    expect(r.body).toContain('https://acme.musterd.test/live');
    const sent = seen.at(-1)!;
    expect(sent.url).toBe('https://acme.musterd.test/teams');
    expect(sent.body).toEqual({ slug: 'acme', display: 'Acme', creator: { name: 'ada' } });
    // The bearer is a console token for the team servers' audience, from this account, signed
    // by the key the JWKS publishes (the team server's own check is cloud/consoleToken.ts).
    const token = sent.auth!.replace(/^Bearer /, '');
    const [h, p, sig] = token.split('.');
    expect(
      verify(
        'sha256',
        Buffer.from(`${h}.${p}`),
        {
          key: createPublicKey({ key: await signer.publicJwk(), format: 'jwk' }),
          dsaEncoding: 'ieee-p1363',
        },
        Buffer.from(sig!, 'base64url'),
      ),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(p!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims['sub']).toBe('acct_1');
    expect(claims['aud']).toBe('https://musterd.test');
    expect(claims['iss']).toBe(ISSUER);
    // The audit row names the slug and the jti, never a credential; the log holds no secret.
    const audit = await q.query<{ action: string; detail: string }>(
      "SELECT action, detail FROM audit WHERE action = 'team.create' ORDER BY ts DESC LIMIT 1",
    );
    expect(audit.rows[0]!.action).toBe('team.create');
    expect(audit.rows[0]!.detail).toContain('"slug":"acme"');
    expect(audit.rows[0]!.detail).toContain('"status":201');
    expect(audit.rows[0]!.detail).not.toContain('SHOWN_ONCE');
    expect(lines.join('\n')).not.toContain('SHOWN_ONCE');
  });

  it('a taken name is a field error with the typed values kept, and nothing else is shown', async () => {
    answer = {
      status: 409,
      body: { error: { code: 'conflict', message: 'team "acme" already exists' } },
    };
    const r = await post({ slug: 'acme', display: 'Acme again', name: 'ada' });
    expect(r.status).toBe(409);
    expect(r.body).toContain('That team name is taken.');
    expect(r.body).toContain('value="Acme again"');
    expect(r.body).not.toContain('Team created');
  });

  it('refuses a bad slug and a bad seat name before any token is minted', async () => {
    const before = seen.length;
    expect((await post({ slug: 'Not Valid!', name: 'ada' })).status).toBe(400);
    expect((await post({ slug: 'fine', name: 'has space' })).status).toBe(400);
    expect(seen.length).toBe(before);
  });

  it('an unreachable team server is a form error, and the audit says so', async () => {
    answer = () => {
      throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
    };
    const r = await post({ slug: 'ghost', name: 'ada' });
    expect(r.status).toBe(502);
    expect(r.body).toContain('could not be reached');
    const audit = await q.query<{ detail: string }>(
      "SELECT detail FROM audit WHERE action = 'team.create' ORDER BY ts DESC LIMIT 1",
    );
    expect(audit.rows[0]!.detail).toContain('"failed":"TimeoutError"');
    answer = { status: 201, body: {} };
  });

  it('refuses a missing session and a bad CSRF token', async () => {
    expect((await post({ slug: 'x', name: 'ada' }, csrfTokenFor(sid), 'nope')).status).toBe(401);
    expect((await post({ slug: 'x', name: 'ada' }, 'bad')).status).toBe(403);
  });
});

describe('POST /teams when the console cannot create teams', () => {
  it('is 404 with no form on the account page', async () => {
    const db = await pglite();
    await db.db.exec('CREATE ROLE console_app NOLOGIN');
    await migrate(db.q, 'console_app');
    await db.q.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', ['acct_2', 1]);
    const sid = await createSession(
      db.q,
      { accountId: 'acct_2', method: 'email', identityProvider: 'email', identitySubject: 'b@x' },
      Date.now(),
    );
    const server = createConsoleServer({
      config: {
        databaseUrl: 'postgres://x@db.test/console',
        issuer: ISSUER,
        allowedHosts: ['app.musterd.test'],
        host: '127.0.0.1',
        port: 0,
        build: null,
        providers: {},
        email: null,
        kms: null,
        teams: null,
      },
      db: db.q,
      log: makeLog(() => undefined),
      signer: localSigner(),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const hit = (path: string, method: string, body?: string) =>
      new Promise<{ status: number; body: string }>((resolve, reject) => {
        const r = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method,
            headers: {
              host: 'app.musterd.test',
              origin: ISSUER,
              cookie: `__Host-session=${sid}`,
              'content-type': 'application/x-www-form-urlencoded',
            },
          },
          (res) => {
            let b = '';
            res.on('data', (c: Buffer) => (b += c.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }));
          },
        );
        r.on('error', reject);
        if (body) r.write(body);
        r.end();
      });
    expect((await hit('/account', 'GET')).body).not.toContain('Create a team');
    expect(
      (
        await hit(
          '/teams',
          'POST',
          new URLSearchParams({ slug: 'x', name: 'a', csrf: csrfTokenFor(sid) }).toString(),
        )
      ).status,
    ).toBe(404);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

describe('MUSTERD_CONSOLE_TEAM_* config', () => {
  const base = {
    MUSTERD_CONSOLE_DATABASE_URL: 'postgres://x@db.test/console',
    MUSTERD_CONSOLE_ISSUER: 'https://app.musterd.test',
  };
  it('is off with neither set, on with both, refused with one', () => {
    expect(resolveConsoleConfig(base).teams).toBeNull();
    expect(
      resolveConsoleConfig({
        ...base,
        MUSTERD_CONSOLE_TEAM_SUFFIX: 'Musterd.dev',
        MUSTERD_CONSOLE_TEAM_AUDIENCE: 'https://musterd.dev',
      }).teams,
    ).toEqual({ suffix: 'musterd.dev', audience: 'https://musterd.dev' });
    expect(() =>
      resolveConsoleConfig({ ...base, MUSTERD_CONSOLE_TEAM_SUFFIX: 'musterd.dev' }),
    ).toThrow(/set together/);
    expect(() =>
      resolveConsoleConfig({
        ...base,
        MUSTERD_CONSOLE_TEAM_SUFFIX: 'https://musterd.dev',
        MUSTERD_CONSOLE_TEAM_AUDIENCE: 'https://musterd.dev',
      }),
    ).toThrow(/bare host suffix/);
  });
});
