import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { accountKey } from './accountKey.js';
import { start } from './server.js';

const SECRET = 'xi-test-secret-key-do-not-leak';

describe('start', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server?.close((err) => (err ? reject(err) : resolve())),
      );
      server = undefined;
    }
  });

  it('serves the page on loopback and keeps the key out of it', async () => {
    const fetchSub = vi.fn<typeof fetch>(async () => {
      return new Response(
        JSON.stringify({
          tier: 'starter',
          character_count: 1000,
          character_limit: 10000,
          status: 'active',
        }),
        { status: 200 },
      );
    });
    const dir = await mkdtemp(join(tmpdir(), 'allowance-'));
    server = await start({
      port: 0,
      env: { ELEVENLABS_API_KEY: SECRET },
      now: () => Date.UTC(2026, 9, 19, 14, 14),
      timeZone: 'UTC',
      fetchSub,
      configPath: join(dir, 'config.json'),
      codexAuthPath: null,
      claudeCredentialPath: null,
      claudeToken: null,
      cursorAuthPath: null,
      cursorToken: null,
      museAuthPath: null,
    });
    const address = server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    if (address === null || typeof address !== 'object') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;

    const page = await fetch(`${base}/`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('9,000 characters left of 10,000.');
    expect(html).toContain('value="opencode"');
    expect(html).not.toContain('OpenCode spends other providers');
    expect(html).not.toContain(SECRET);

    const api = await fetch(`${base}/api/board`);
    const json = await api.text();
    expect(json).not.toContain(SECRET);
    expect(json).toContain('"state":"live"');
    expect(json).not.toContain('"state":"quiet"');

    const css = await fetch(`${base}/allowance.css`);
    expect(await css.text()).toContain('.p10{width:10%}');

    const font = await fetch(`${base}/fonts/dm-sans-latin.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');

    expect((await fetch(`${base}/fonts/nope.woff2`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);

    const saved = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: `http://127.0.0.1:${address.port}`,
      },
      body: 'account=openai&account=nope&account=claude',
      redirect: 'manual',
    });
    expect(saved.status).toBe(303);
    expect(saved.headers.get('location')).toBe('/');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toContain('"openai"');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).not.toContain('nope');

    const blocked = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { origin: 'https://evil.example' },
      body: 'account=exa',
    });
    expect(blocked.status).toBe(403);
    expect(await blocked.text()).toBe('That save did not come from this page.');

    const opaque = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin: 'null',
        'sec-fetch-site': 'same-origin',
      },
      body: 'account=grok',
      redirect: 'manual',
    });
    expect(opaque.status).toBe(303);
    expect(opaque.headers.get('location')).toBe('/');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).toContain('"grok"');

    const crossed = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { origin: 'null', 'sec-fetch-site': 'cross-site' },
      body: 'account=exa',
    });
    expect(crossed.status).toBe(403);
    expect(await crossed.text()).toBe('That save did not come from this page.');
    expect(await readFile(join(dir, 'config.json'), 'utf8')).not.toContain('exa');

    const bareNull = await fetch(`${base}/accounts`, {
      method: 'POST',
      headers: { origin: 'null' },
      body: 'account=hume',
    });
    expect(bareNull.status).toBe(403);
    expect(await readFile(join(dir, 'config.json'), 'utf8')).not.toContain('hume');

    const huge = await fetch(`${base}/accounts`, {
      method: 'POST',
      body: `account=exa&pad=${'x'.repeat(5000)}`,
    });
    expect(huge.status).toBe(413);
  });

  it('posts a Muse window and not the auth email or the access token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'allowance-muse-'));
    const email = 'ada@example.com';
    const token = 'secret-token-value';
    await writeFile(
      join(dir, 'auth.json'),
      JSON.stringify({ user_email: email, providers: { muse: { access_token: token } } }),
    );
    await writeFile(join(dir, 'config.json'), JSON.stringify({ accounts: ['muse'] }));
    const posts: string[] = [];
    const fetchSub = vi.fn<typeof fetch>(async (_url, init) => {
      posts.push(String(init?.body ?? ''));
      return new Response('{}', { status: 200 });
    });
    server = await start({
      port: 0,
      env: {
        MUSTERD_TEAM: 'revive',
        MUSTERD_SERVER: 'http://127.0.0.1:4849',
        MUSTERD_CONFIG: join(dir, 'missing.json'),
      },
      now: () => 1_700_000_000_000,
      timeZone: 'UTC',
      fetchSub,
      configPath: join(dir, 'config.json'),
      codexAuthPath: null,
      claudeCredentialPath: null,
      claudeToken: null,
      cursorAuthPath: null,
      cursorToken: null,
      museAuthPath: join(dir, 'auth.json'),
      readMuse: async () => ({
        state: 'live',
        detail: null,
        windows: [
          {
            id: 'session',
            unit: 'percent',
            used: 35,
            limit: 100,
            resetsAt: 1_700_000_100_000,
            label: '5-hour window',
          },
        ],
      }),
    });
    const address = server.address();
    if (address === null || typeof address !== 'object') throw new Error('no port');
    const api = await fetch(`http://127.0.0.1:${address.port}/api/board`);
    const json = await api.text();
    expect(api.status).toBe(200);
    expect(json).toContain('"id":"muse"');
    expect(json).not.toContain(email);
    expect(json).not.toContain(token);
    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toContain(email);
    expect(posts[0]).not.toContain(token);
    expect(JSON.parse(posts[0] ?? '{}')).toEqual({
      accounts: [
        {
          provider: 'muse',
          account: accountKey('muse', `id:${email}`),
          label: 'Muse',
          readAt: 1_700_000_000_000,
          windows: [{ name: '5h', left: 0.65, resetsAt: 1_700_000_100_000, kind: 'percent' }],
        },
      ],
    });
  });
});
