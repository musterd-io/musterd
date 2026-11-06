import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ConsoleConfig } from './config.js';
import { callbackUrl, handbackCsp, handbackPath, parseHandbackShape } from './handback.js';
import { createConsoleServer } from './http.js';
import { makeLog } from './log.js';
import { migrate } from './schema.js';
import { createSession } from './sessions.js';
import { pglite } from './testing.js';
import { localSigner, type TokenSigner } from './tokens.js';

const ISSUER = 'https://app.musterd.test';
const AUD = 'https://musterd.test';
const STATE = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';
const GOOD = handbackPath({ aud: AUD, team: 'acme', state: STATE });

describe('handback shape (ADR 722 §1)', () => {
  it('the canonical path round-trips', () => {
    expect(GOOD).toBe(`/handback?aud=${encodeURIComponent(AUD)}&team=acme&state=${STATE}`);
    expect(parseHandbackShape(GOOD)).toEqual({ aud: AUD, team: 'acme', state: STATE });
  });

  it('refuses a bad slug, a short state, a repeated, missing or extra param, another path', () => {
    const q = (s: string) => parseHandbackShape(s);
    expect(q(GOOD.replace('team=acme', 'team=Acme.evil'))).toBeNull();
    expect(q(GOOD.replace(STATE, 'short'))).toBeNull();
    expect(q(`${GOOD}&team=other`)).toBeNull();
    expect(q(`${GOOD}&return=https%3A%2F%2Fevil.test`)).toBeNull();
    expect(q(GOOD.replace('&team=acme', ''))).toBeNull();
    expect(q(GOOD.replace('/handback', '/handback2'))).toBeNull();
    expect(q(GOOD.replace(`aud=${encodeURIComponent(AUD)}`, 'aud=has%20space'))).toBeNull();
  });

  it('builds the callback from the team and the configured suffix only', () => {
    expect(callbackUrl('acme', 'musterd.test')).toBe(
      'https://acme.musterd.test/live/signin/callback',
    );
  });

  it('the CSP allows only the callback origin as a form target and only our own script', () => {
    const csp = handbackCsp('https://acme.musterd.test');
    expect(csp).toContain('form-action https://acme.musterd.test;');
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain("form-action 'self'");
  });
});

describe('GET /handback', () => {
  let port = 0;
  let q: Awaited<ReturnType<typeof pglite>>['q'];
  let close: () => Promise<void> = async () => undefined;
  const signer = localSigner();
  const sids: Record<'github' | 'email', string> = { github: '', email: '' };

  async function boot(opts: { signer?: TokenSigner; teams?: boolean } = {}) {
    const config: ConsoleConfig = {
      databaseUrl: 'postgres://x@db.test/console',
      issuer: ISSUER,
      allowedHosts: ['app.musterd.test'],
      host: '127.0.0.1',
      port: 0,
      build: null,
      providers: {},
      // On, so the sign-in page has a form for the hand-back to ride (never sent: no POST here).
      email: { accountId: 'a', apiToken: 't', fromAddress: 'f@musterd.test', fromName: 'musterd' },
      kms: null,
      teams: opts.teams === false ? null : { suffix: 'musterd.test', audience: AUD },
    };
    const server = createConsoleServer({
      config,
      db: q,
      log: makeLog(() => undefined),
      ...(opts.signer ? { signer: opts.signer } : {}),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return {
      port: (server.address() as AddressInfo).port,
      close: () => new Promise<void>((r) => server.close(() => r())),
    };
  }

  beforeAll(async () => {
    const db = await pglite();
    q = db.q;
    await db.db.exec('CREATE ROLE console_app NOLOGIN');
    await migrate(q, 'console_app');
    const t = Date.now();
    for (const [acct, provider, subject, email] of [
      ['acct_gh', 'github', '1234', null],
      ['acct_mail', 'email', 'ada@example.test', 'ada@example.test'],
    ] as const) {
      await q.query('INSERT INTO accounts (id, created_at) VALUES ($1, $2)', [acct, t]);
      await q.query(
        'INSERT INTO identities (provider, subject, account_id, email, created_at) VALUES ($1, $2, $3, $4, $5)',
        [provider, subject, acct, email, t],
      );
      sids[provider] = await createSession(
        q,
        { accountId: acct, method: provider, identityProvider: provider, identitySubject: subject },
        t,
      );
    }
    const b = await boot({ signer });
    port = b.port;
    close = b.close;
  });
  afterAll(() => close());

  function get(path: string, opts: { sid?: string; port?: number; method?: string } = {}) {
    return new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const r = request(
          {
            host: '127.0.0.1',
            port: opts.port ?? port,
            path,
            method: opts.method ?? 'GET',
            headers: {
              host: 'app.musterd.test',
              ...(opts.sid ? { cookie: `__Host-session=${opts.sid}` } : {}),
            },
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
        r.end();
      },
    );
  }

  const field = (body: string, name: string) =>
    new RegExp(`name="${name}" value="([^"]*)"`).exec(body)?.[1];
  const payload = (token: string) =>
    JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString()) as Record<
      string,
      unknown
    >;
  const issued = async () =>
    (
      await q.query<{ detail: string }>(
        "SELECT detail FROM audit WHERE action = 'statement.issue' ORDER BY ts",
      )
    ).rows.map((r) => JSON.parse(r.detail) as Record<string, unknown>);

  it('no session: the sign-in page, carrying the canonical handback path as its return', async () => {
    const r = await get(GOOD);
    expect(r.status).toBe(200);
    expect(r.body).toContain('<h1>Sign in</h1>');
    expect(field(r.body, 'return')).toBe(GOOD.replace(/&/g, '&amp;'));
  });

  it('another audience, a bad slug or an extra param is the error page, and nothing is signed', async () => {
    const before = (await issued()).length;
    for (const path of [
      handbackPath({ aud: 'https://other.test', team: 'acme', state: STATE }),
      GOOD.replace('team=acme', 'team=a.b'),
      `${GOOD}&url=https%3A%2F%2Fevil.test`,
    ]) {
      const r = await get(path, { sid: sids.email });
      expect(r.status).toBe(400);
      expect(r.body).toContain("This sign-in link isn't valid");
    }
    expect((await issued()).length).toBe(before);
  });

  it('signed in: a form that POSTs the state and a statement to the team callback, under a CSP that allows only that', async () => {
    const r = await get(GOOD, { sid: sids.email });
    expect(r.status).toBe(200);
    expect(r.body).toContain('action="https://acme.musterd.test/live/signin/callback"');
    expect(r.body).toContain('method="post"');
    expect(r.body).toContain('<script src="/handback.js"></script>');
    expect(field(r.body, 'state')).toBe(STATE);
    const claims = payload(field(r.body, 'statement')!);
    expect(claims).toMatchObject({ sub: 'acct_mail', aud: AUD, use: 'identity', iss: ISSUER });
    expect(claims.email).toBe('ada@example.test');
    expect(r.headers['content-security-policy']).toContain(
      'form-action https://acme.musterd.test;',
    );
    // strict-origin, not no-referrer or same-origin: under either, a browser sends `Origin: null` on
    // this cross-site POST and the team refuses it (found by the real-browser e2e, 2026-11-06).
    expect(r.headers['referrer-policy']).toBe('strict-origin');
    expect(r.headers['cache-control']).toBe('no-store');
  });

  it('a GitHub account, which has no email, gets a statement without one', async () => {
    const r = await get(GOOD, { sid: sids.github });
    expect(r.status).toBe(200);
    const claims = payload(field(r.body, 'statement')!);
    expect(claims.sub).toBe('acct_gh');
    expect('email' in claims).toBe(false);
  });

  it('two visits sign two jti, each audited by aud, team and jti — never the statement', async () => {
    const before = (await issued()).length;
    const a = payload(field((await get(GOOD, { sid: sids.email })).body, 'statement')!);
    const b = payload(field((await get(GOOD, { sid: sids.email })).body, 'statement')!);
    expect(a.jti).not.toBe(b.jti);
    const rows = (await issued()).slice(before);
    expect(rows).toHaveLength(2);
    // Two rows can share a millisecond, so their order is not asserted.
    expect(rows).toEqual(
      expect.arrayContaining([
        { aud: AUD, team: 'acme', jti: a.jti },
        { aud: AUD, team: 'acme', jti: b.jti },
      ]),
    );
  });

  it('HEAD answers the headers and signs nothing', async () => {
    const before = (await issued()).length;
    const r = await get(GOOD, { sid: sids.email, method: 'HEAD' });
    expect(r.status).toBe(200);
    expect(r.body).toBe('');
    expect((await issued()).length).toBe(before);
  });

  it('serves the submit script', async () => {
    const r = await get('/handback.js');
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'])).toContain('javascript');
    expect(r.body).toContain('submit()');
  });

  it('is 404 with no signer or no team configuration', async () => {
    for (const opts of [{}, { signer, teams: false }]) {
      const b = await boot(opts);
      expect((await get(GOOD, { sid: sids.email, port: b.port })).status).toBe(404);
      await b.close();
    }
  });

  it("is charged to the account's token bucket: the 31st in a minute is 429", async () => {
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await get(GOOD, { sid: sids.github })).status;
    expect(last).toBe(429);
  });
});
