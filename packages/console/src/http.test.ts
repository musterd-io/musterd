import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConsoleConfig } from './config.js';
import { hostCookie } from './cookies.js';
import type { Queryable } from './db.js';
import { createConsoleServer } from './http.js';
import { makeLog } from './log.js';

const config: ConsoleConfig = {
  databaseUrl: 'postgres://x@db.test/console',
  issuer: 'https://app.musterd.test',
  allowedHosts: ['app.musterd.test'],
  host: '127.0.0.1',
  port: 0,
  build: 'abc123',
};
const okDb: Queryable = { query: async () => ({ rows: [] }) };
const downDb: Queryable = {
  query: async () => {
    throw new Error('connect ECONNREFUSED postgres://console_app:s3cretpw@10.0.0.1:5432/console');
  },
};

let stop: (() => Promise<void>) | null = null;
afterEach(async () => {
  await stop?.();
  stop = null;
});

async function boot(db: Queryable = okDb) {
  const lines: string[] = [];
  const server = createConsoleServer({ config, db, log: makeLog((l) => lines.push(l)) });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  stop = () => new Promise((r) => server.close(() => r()));
  const port = (server.address() as AddressInfo).port;
  const call = (
    path: string,
    opts: { method?: string; host?: string; headers?: Record<string, string> } = {},
  ) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>(
      (resolve, reject) => {
        const r = request(
          {
            host: '127.0.0.1',
            port,
            path,
            method: opts.method ?? 'GET',
            headers: { host: opts.host ?? 'app.musterd.test', ...(opts.headers ?? {}) },
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
  return { call, lines };
}

describe('console HTTP boundary (ADR 615)', () => {
  it('/health answers ok with the build, and one fixed sentence when the database is down', async () => {
    const up = await boot();
    const h = await up.call('/health');
    expect(h.status).toBe(200);
    expect(JSON.parse(h.body)).toEqual({ ok: true, build: 'abc123' });
    await stop?.();
    const down = await boot(downDb);
    const d = await down.call('/health');
    expect(d.status).toBe(503);
    expect(JSON.parse(d.body)).toEqual({ ok: false, reason: 'database unreachable' });
    expect(d.body).not.toContain('s3cretpw');
    expect(down.lines.join('\n')).not.toContain('s3cretpw');
  });

  it('serves an empty JWKS, cacheable', async () => {
    const { call } = await boot();
    const j = await call('/.well-known/jwks.json');
    expect(j.status).toBe(200);
    expect(JSON.parse(j.body)).toEqual({ keys: [] });
    expect(j.headers['cache-control']).toBe('public, max-age=300');
  });

  it('exposes nothing else: unknown routes 404, non-GET 405, a foreign host 404', async () => {
    const { call } = await boot();
    for (const p of ['/login', '/token', '/teams', '/.well-known/openid-configuration', '/'])
      expect((await call(p)).status, p).toBe(404);
    const post = await call('/health', { method: 'POST' });
    expect(post.status).toBe(405);
    expect(post.headers['allow']).toBe('GET, HEAD');
    expect((await call('/health', { host: 'evil.test' })).status).toBe(404);
    expect((await call('/health', { host: 'revive.musterd.test' })).status).toBe(404);
  });

  it('every response carries the security headers and a request id', async () => {
    const { call } = await boot();
    const r = await call('/nope');
    expect(r.headers['strict-transport-security']).toMatch(/max-age=/);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.headers['cache-control']).toBe('no-store');
    expect(String(r.headers['x-request-id'])).toMatch(/^[A-Za-z0-9._-]{8,64}$/);
    expect(JSON.parse(r.body)).toEqual({ error: { code: 'not_found', message: 'not found' } });
  });

  it('keeps a safe inbound request id and replaces an unsafe one', async () => {
    const { call } = await boot();
    const kept = await call('/health', { headers: { 'x-request-id': 'rid-12345678' } });
    expect(kept.headers['x-request-id']).toBe('rid-12345678');
    const replaced = await call('/health', { headers: { 'x-request-id': 'bad id <script>' } });
    expect(replaced.headers['x-request-id']).not.toContain(' ');
  });

  it('logs route, status and id — never the path, query, headers or a secret, on any path', async () => {
    const { call, lines } = await boot(downDb);
    const secretHeaders = {
      authorization: 'Bearer mscr_abcdefghijklmnopqrstuvwxyz0123',
      cookie: '__Host-session=topsecretvalue',
    };
    await call('/health?code=magic-abc123', { headers: secretHeaders });
    await call('/login?token=mskey_abcdefghijklmnopqrstuvwxyz', { headers: secretHeaders });
    await call('/health', { method: 'POST', headers: secretHeaders });
    const all = lines.join('\n');
    for (const leak of [
      'mscr_',
      'mskey_',
      'topsecretvalue',
      'magic-abc123',
      's3cretpw',
      '/login',
      '?',
    ])
      expect(all, leak).not.toContain(leak);
    const routes = lines.map(
      (l) => JSON.parse(l) as { msg: string; route?: string; status?: number },
    );
    expect(routes.filter((r) => r.msg === 'http_request').map((r) => [r.route, r.status])).toEqual([
      ['health', 503],
      ['unmatched', 404],
      ['method_not_allowed', 405],
    ]);
  });
});

describe('hostCookie (ADR 615)', () => {
  it('always __Host-, Secure, Path=/, HttpOnly, SameSite=Lax, no Domain', () => {
    const c = hostCookie('session', 'abc.DEF-123', 3600);
    expect(c).toBe(
      '__Host-session=abc.DEF-123; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600',
    );
    expect(c).not.toMatch(/Domain=/i);
    expect(() => hostCookie('bad name', 'x')).toThrow();
    expect(() => hostCookie('s', 'v;Domain=evil')).toThrow();
  });
});
