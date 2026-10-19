import type { Server } from 'node:http';
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
    server = await start({
      port: 0,
      env: { ELEVENLABS_API_KEY: SECRET },
      now: () => Date.UTC(2026, 9, 19, 14, 14),
      timeZone: 'UTC',
      fetchSub,
    });
    const address = server.address();
    expect(address).toMatchObject({ address: '127.0.0.1' });
    if (address === null || typeof address !== 'object') throw new Error('no port');
    const base = `http://127.0.0.1:${address.port}`;

    const page = await fetch(`${base}/`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain('9,000 characters left of 10,000.');
    expect(html).toContain('OpenCode');
    expect(html).not.toContain(SECRET);

    const api = await fetch(`${base}/api/board`);
    const json = await api.text();
    expect(json).not.toContain(SECRET);
    expect(json).toContain('"state":"quiet"');

    const css = await fetch(`${base}/allowance.css`);
    expect(await css.text()).toContain('.p10{width:10%}');

    const font = await fetch(`${base}/fonts/recursive-linear.woff2`);
    expect(font.status).toBe(200);
    expect(font.headers.get('content-type')).toBe('font/woff2');

    expect((await fetch(`${base}/fonts/nope.woff2`)).status).toBe(404);
    expect((await fetch(`${base}/nope`)).status).toBe(404);
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405);
  });
});
