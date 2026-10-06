/**
 * Service tests: the real HTTP surface on an OS-assigned port, plus a raw ws upgrade smoke —
 * the same transports the MCP client and the browser page use.
 */
import { statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import { readServiceToken, serviceTokenPath } from './auth.js';
import type { Outline } from './port.js';
import { chooseProvider, startService, type RunningService } from './service.js';

let dir: string;
let service: RunningService;
let base: string;

/** fetch with the service's token, as the MCP client sends it (auth.ts). */
const authFetch = (url: string, init: RequestInit = {}): Promise<Response> =>
  fetch(url, {
    ...init,
    headers: {
      ...(init.headers as Record<string, string> | undefined),
      Authorization: `Bearer ${readServiceToken(service.port)}`,
    },
  });

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'whiteboard-service-test-'));
  process.env['WHITEBOARD_DATA_DIR'] = dir;
  // These tests exercise the tldraw provider. The repo-root vitest run ignores this package's
  // env pin, and the vendored Squig is always present (ADR 537), so pin tldraw here.
  process.env['WHITEBOARD_PROVIDER'] = 'tldraw';
  service = await startService(0);
  base = `http://127.0.0.1:${service.port}`;
});

afterEach(async () => {
  await service.close();
  delete process.env['WHITEBOARD_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

describe('service', () => {
  it('healthz identifies itself — the spawn-on-demand probe depends on this', async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'agent-whiteboard' });
  });

  it('drives the full board flow over HTTP', async () => {
    const open = await authFetch(`${base}/api/boards/flow/open`, { method: 'POST' });
    const opened = (await open.json()) as { created: boolean; url: string };
    expect(opened.created).toBe(true);
    expect(opened.url).toContain(`/b/flow`);

    const add = await authFetch(`${base}/api/boards/flow/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'seat:izzo',
        items: [
          { kind: 'note', text: 'one' },
          { kind: 'note', text: 'two' },
        ],
      }),
    });
    const added = (await add.json()) as { ids: string[]; version: number };
    expect(added.ids).toHaveLength(2);

    const read = await authFetch(`${base}/api/boards/flow/outline`);
    const outline = (await read.json()) as Outline;
    expect(outline.items.map((i) => i.text).sort()).toEqual(['one', 'two']);

    const diffRes = await authFetch(`${base}/api/boards/flow/outline?since=${outline.version}`);
    const diff = (await diffRes.json()) as Outline;
    expect(diff.items).toHaveLength(0);

    const edit = await authFetch(`${base}/api/boards/flow/edit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'seat:izzo',
        ops: [{ op: 'retitle', id: added.ids[0], text: 'one, sharpened' }],
      }),
    });
    expect((await edit.json()) as { refused: unknown[] }).toMatchObject({ refused: [] });

    const closeRes = await authFetch(`${base}/api/boards/flow/close`, { method: 'POST' });
    const closed = (await closeRes.json()) as { outline: Outline };
    expect(closed.outline.items.map((i) => i.text).sort()).toEqual(['one, sharpened', 'two']);

    const list = await authFetch(`${base}/api/boards`);
    expect(
      ((await list.json()) as { boards: Array<{ name: string }> }).boards.map((b) => b.name),
    ).toContain('flow');
  });

  it('accepts a huddle layout — the shape `musterd huddle open` sends (ADR 378 §7)', async () => {
    // The CLI talks to this port over raw HTTP and imports nothing from here; this pins the
    // payload it sends so a port change on either side fails a test rather than a huddle.
    const board = 'huddle-01huddle0000000000000000aa';
    const open = await authFetch(`${base}/api/boards/${board}/open`, { method: 'POST' });
    expect(((await open.json()) as { created: boolean }).created).toBe(true);
    const add = await authFetch(`${base}/api/boards/${board}/add`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        actor: 'seat:izzo',
        items: [
          { kind: 'cluster', title: 'Anchor', x: 100, y: 100 },
          {
            kind: 'note',
            text: 'docs/design/thing.md',
            detail: 'anchor — docs/design/thing.md',
            x: 120,
            y: 160,
          },
          { kind: 'label', text: 'huddle · lane:01LANE', x: 100, y: 40 },
          { kind: 'cluster', title: 'Turns', x: 600, y: 100 },
          { kind: 'note', text: 'why we huddle', detail: 'why we huddle', x: 620, y: 160 },
        ],
      }),
    });
    expect(add.status).toBe(200);
    expect(((await add.json()) as { ids: string[] }).ids).toHaveLength(5);
    const outline = (await (
      await authFetch(`${base}/api/boards/${board}/outline`)
    ).json()) as Outline;
    expect(
      outline.items
        .filter((i) => i.kind === 'cluster')
        .map((i) => i.text)
        .sort(),
    ).toEqual(['Anchor', 'Turns']);
  });

  it('rejects invalid board names', async () => {
    const res = await authFetch(`${base}/api/boards/..%2Fescape/open`, { method: 'POST' });
    expect(res.status).toBe(400);
  });

  it('completes the sync handshake over a real ws — a browser could join this room', async () => {
    await authFetch(`${base}/api/boards/wsboard/open`, { method: 'POST' });
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/wsboard`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    // The sync protocol is client-initiated: send the connect request a tldraw client would.
    const { getTlsyncProtocolVersion } = await import('@tldraw/sync-core');
    const { TLDRAW_SCHEMA } = await import('./tldraw/records.js');
    ws.send(
      JSON.stringify({
        type: 'connect',
        connectRequestId: 'test',
        schema: TLDRAW_SCHEMA,
        protocolVersion: getTlsyncProtocolVersion(),
        lastServerClock: 0,
      }),
    );
    const reply = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no connect reply within 3s')), 3000);
      ws.once('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(String(data)) as Record<string, unknown>);
      });
      ws.once('error', reject);
    });
    expect(reply['type']).toBe('connect');
    expect(reply['connectRequestId']).toBe('test');
    ws.close();
  });

  it('refuses a ws upgrade for a bad board name', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/..%2Fnope`);
    const failed = await new Promise<boolean>((resolve) => {
      ws.once('error', () => resolve(true));
      ws.once('open', () => resolve(false));
    });
    expect(failed).toBe(true);
  });
});

describe('chooseProvider (ADR 524)', () => {
  const ok = () => ({
    ok: true as const,
    checkout: { kind: 'checkout' as const, root: '/s', entry: '/e', loader: '/l', node: '/n' },
  });
  const missing = () => ({ ok: false as const, reason: 'no Squig checkout at /h/.squig/src' });

  it('defaults to Squig when a usable checkout exists', () => {
    expect(chooseProvider({}, ok).name).toBe('squig');
  });

  it('falls back to tldraw without a checkout, and says why', () => {
    expect(chooseProvider({}, missing)).toEqual({
      name: 'tldraw',
      fallback: 'no Squig checkout at /h/.squig/src — using tldraw',
    });
  });

  it('WHITEBOARD_PROVIDER=tldraw pins tldraw; =squig without a checkout still falls back, loudly', () => {
    expect(chooseProvider({ WHITEBOARD_PROVIDER: 'tldraw' }, ok)).toEqual({ name: 'tldraw' });
    expect(chooseProvider({ WHITEBOARD_PROVIDER: 'squig' }, missing).fallback).toMatch(
      /^WHITEBOARD_PROVIDER=squig, but no Squig checkout/,
    );
  });
});

describe('the guard (lane 01M47FADGV)', () => {
  it('writes a 0600 token, refuses /api without it, and removes it on close', async () => {
    expect(statSync(serviceTokenPath(service.port)).mode & 0o777).toBe(0o600);
    const bare = await fetch(`${base}/api/boards`);
    expect(bare.status).toBe(401);
    const wrong = await fetch(`${base}/api/boards/x/link`, {
      method: 'POST',
      headers: { Authorization: 'Bearer nope', 'Content-Type': 'text/plain' },
      body: JSON.stringify({ file: '/tmp/evil.squig.json' }),
    });
    expect(wrong.status).toBe(401);
    expect((await authFetch(`${base}/api/boards`)).status).toBe(200);
  });

  it('refuses a request whose Host is not localhost — a DNS-rebound page', async () => {
    const res = await new Promise<number>((resolve) => {
      const req = request(
        {
          host: '127.0.0.1',
          port: service.port,
          path: '/healthz',
          headers: { Host: `evil.example:${service.port}` },
        },
        (r) => resolve(r.statusCode ?? 0),
      );
      req.end();
    });
    expect(res).toBe(403);
  });

  it('refuses a websocket from a foreign Origin, and accepts its own page', async () => {
    await authFetch(`${base}/api/boards/wsg/open`, { method: 'POST' });
    const outcome = (origin: string) =>
      new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${service.port}/ws/wsg`, { origin });
        ws.on('open', () => {
          ws.close();
          resolve('open');
        });
        ws.on('unexpected-response', (_req, r) => resolve(String(r.statusCode)));
        ws.on('error', () => resolve('error'));
      });
    expect(await outcome('https://evil.example')).toBe('403');
    expect(await outcome(`http://localhost:${service.port}`)).toBe('open');
  });
});
