import { mkdtemp, readFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

    const font = await fetch(`${base}/fonts/recursive-linear.woff2`);
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

    const huge = await fetch(`${base}/accounts`, {
      method: 'POST',
      body: `account=exa&pad=${'x'.repeat(5000)}`,
    });
    expect(huge.status).toBe(413);
  });
});
