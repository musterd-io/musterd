import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleConfig } from './config.js';
import type { Queryable } from './db.js';
import { signInMessage } from './email.js';
import { createConsoleServer } from './http.js';
import { makeLog } from './log.js';
import { accountPage } from './pages.js';

const config: ConsoleConfig = {
  databaseUrl: 'postgres://x@db.test/console',
  issuer: 'https://app.musterd.test',
  allowedHosts: ['app.musterd.test'],
  host: '127.0.0.1',
  port: 0,
  build: 'abc123',
  providers: {
    github: { clientId: 'gh-id', clientSecret: 'gh-secret' },
    google: { clientId: 'go-id', clientSecret: 'go-secret' },
  },
  email: {
    accountId: 'acc',
    apiToken: 'tok',
    fromAddress: 'signin@musterd.io',
    fromName: 'musterd',
  },
  kms: null,
};
const okDb: Queryable = { query: async () => ({ rows: [] }) };

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function boot(db: Queryable = okDb, cfg: ConsoleConfig = config) {
  const lines: string[] = [];
  const sent: { to: string; link: string }[] = [];
  const server = createConsoleServer({
    config: cfg,
    db,
    log: makeLog((l) => lines.push(l)),
    sendEmail: async (_c, m) => {
      sent.push(m);
      return true;
    },
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stop = () => new Promise((r) => server.close(() => r()));
  const port = (server.address() as AddressInfo).port;
  const call = (
    path: string,
    opts: { method?: string; body?: string; headers?: Record<string, string> } = {},
  ) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
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
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () =>
              resolve({
                status: res.statusCode ?? 0,
                headers: res.headers,
                body: Buffer.concat(chunks).toString(),
              }),
            );
          },
        );
        r.on('error', reject);
        r.end(opts.body);
      },
    );
  return { call, lines, sent };
}

const form = {
  'content-type': 'application/x-www-form-urlencoded',
  origin: 'https://app.musterd.test',
};

describe('console sign-in pages (design 2026-10-15, copy spec)', () => {
  it('GET / serves the sign-in page: exact copy, POST forms, page CSP, no script', async () => {
    const { call } = await boot();
    const r = await call('/');
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.body).toContain('<title>Sign in — musterd</title>');
    expect(r.body).toContain('<h1>Sign in</h1>');
    expect(r.body).toContain('Sign in to your musterd account.');
    expect(r.body).toContain('action="/auth/github/start"');
    expect(r.body).toContain('action="/auth/google/start"');
    expect(r.body).toContain('action="/auth/email/start"');
    expect(r.body).toContain('Continue with GitHub');
    expect(r.body).toContain('Continue with Google');
    expect(r.body).toContain('Email me a link');
    expect(r.body).toContain(
      'musterd discards your GitHub or Google token after you sign in. A team never receives it.',
    );
    expect(r.body).not.toContain('<script');
    expect(r.body).not.toContain('Your sign-in expired');
    const csp = String(r.headers['content-security-policy']);
    expect(csp).toContain("style-src 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("'unsafe-inline'");
  });

  it('serves the stylesheet, favicon and fonts from its own origin', async () => {
    const { call } = await boot();
    const css = await call('/console.css');
    expect(css.status).toBe(200);
    expect(css.headers['content-type']).toContain('text/css');
    expect(css.body).toContain('--c-accent: #e1ad01');
    expect((await call('/favicon.svg')).status).toBe(200);
    for (const f of ['recursive-linear.woff2', 'recursive-casual.woff2', 'recursive-mono.woff2']) {
      const font = await call(`/fonts/${f}`);
      expect(font.status, f).toBe(200);
      expect(font.headers['content-type']).toContain('font/woff2');
    }
    expect((await call('/fonts/evil.woff2')).status).toBe(404);
  });

  it('hides a sign-in way that is not configured', async () => {
    const { call } = await boot(okDb, { ...config, providers: {}, email: null });
    const r = await call('/');
    expect(r.status).toBe(200);
    expect(r.body).not.toContain('Continue with GitHub');
    expect(r.body).not.toContain('Email me a link');
  });

  it('POST /auth/email/start: bad addresses get the field error, a good one the check-email page', async () => {
    const { call, sent } = await boot();
    const empty = await call('/auth/email/start', {
      method: 'POST',
      headers: form,
      body: 'email=',
    });
    expect(empty.status).toBe(400);
    expect(empty.body).toContain('Enter an email address.');
    expect(empty.body).toContain('aria-invalid="true"');
    const bad = await call('/auth/email/start', {
      method: 'POST',
      headers: form,
      body: 'email=ada%40example',
    });
    expect(bad.status).toBe(400);
    expect(bad.body).toContain('Enter a full email address.');
    expect(bad.body).toContain('value="ada@example"');
    const good = await call('/auth/email/start', {
      method: 'POST',
      headers: form,
      body: 'email=ada%40example.test',
    });
    expect(good.status).toBe(200);
    expect(good.body).toContain('<h1>Check your email</h1>');
    expect(good.body).toContain(
      'We sent a sign-in link to <strong>ada@example.test</strong>. It works for 15 minutes, and only in this browser.',
    );
    expect(sent).toHaveLength(1);
  });

  it('GET /account without a session redirects to the sign-in page', async () => {
    const { call } = await boot();
    const r = await call('/account');
    expect(r.status).toBe(303);
    expect(r.headers['location']).toBe('/');
  });

  it('escapes an address before it reaches a page', async () => {
    const { call } = await boot();
    const r = await call('/auth/email/start', {
      method: 'POST',
      headers: form,
      body: `email=${encodeURIComponent('a"<b>@example.test')}`,
    });
    expect(r.body).not.toContain('a"<b>');
    expect(r.body).toContain('a&quot;&lt;b&gt;@example.test');
  });
});

describe('account page marker (copy spec §6)', () => {
  it('puts Signed in with this on the session row only', () => {
    const html = accountPage({
      csrf: 'tok',
      methods: [
        { provider: 'github', email: null, current: true },
        { provider: 'email', email: 'ada@example.test', current: false },
      ],
    });
    expect(html).toContain(
      '<span class="c-list__who">GitHub</span><span class="c-list__now">Signed in with this</span>',
    );
    expect(html).toContain('<span class="c-list__who">Email · ada@example.test</span></li>');
    expect(html.match(/Signed in with this/g)).toHaveLength(1);
  });
});

describe('sign-in email words (copy spec §4)', () => {
  it('subject and text are the spec strings, text only', () => {
    const m = signInMessage({
      to: 'a@example.test',
      link: 'https://app.musterd.test/x',
      expiresMinutes: 15,
    });
    expect(m.subject).toBe('Sign in to musterd');
    expect(m.text).toBe(
      'Sign in to your musterd account.\n\n' +
        'This link works for 15 minutes, and only in the browser where you asked for it.\n\n' +
        'https://app.musterd.test/x\n\n' +
        "Didn't ask for this? Ignore this email.",
    );
    expect(m.html).toBeUndefined();
  });
});
