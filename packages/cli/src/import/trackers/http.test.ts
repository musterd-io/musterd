import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { CliError } from '../../errors.js';
import { getJson, TrackerAuthError, type TrackerHttp } from './http.js';

type Reply = { status: number; body?: unknown; headers?: Record<string, string> };

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

/** A fake tracker that answers each request with the next scripted reply. */
async function fake(replies: Reply[]): Promise<{ url: string; hits: () => number }> {
  let n = 0;
  server = createServer((_req: IncomingMessage, res: ServerResponse) => {
    const r = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    res.writeHead(r.status, { 'content-type': 'application/json', ...r.headers });
    res.end(r.body === undefined ? '' : JSON.stringify(r.body));
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}/x`, hits: () => n };
}

function recordingHttp(): TrackerHttp & { slept: number[] } {
  const slept: number[] = [];
  return { fetch, sleep: async (ms) => void slept.push(ms), slept };
}

const ctx = { tracker: 'GitHub', authFix: 'run `gh auth login`' };
const headers = { authorization: 'Bearer ghp_SECRETTOKEN123' };

describe('getJson', () => {
  it('retries a 429 once after Retry-After seconds', async () => {
    const f = await fake([
      { status: 429, headers: { 'retry-after': '3' } },
      { status: 200, body: { ok: 1 } },
    ]);
    const http = recordingHttp();
    const res = await getJson(http, f.url, { headers }, ctx);
    expect(res).toMatchObject({ status: 200, json: { ok: 1 } });
    expect(http.slept).toEqual([3000]);
  });

  it('caps the wait at 30 s and defaults to 2 s', async () => {
    const f = await fake([
      { status: 502, headers: { 'retry-after': '600' } },
      { status: 200, body: [] },
    ]);
    const http = recordingHttp();
    await getJson(http, f.url, { headers }, ctx);
    const g = await fake([{ status: 500 }, { status: 200, body: [] }]);
    await getJson(http, g.url, { headers }, ctx);
    expect(http.slept).toEqual([30_000, 2000]);
  });

  it('gives up after a second 5xx', async () => {
    const f = await fake([{ status: 503 }]);
    await expect(getJson(recordingHttp(), f.url, { headers }, ctx)).rejects.toThrow(
      /GitHub answered 503 twice/,
    );
    expect(f.hits()).toBe(2);
  });

  it('a refused credential is exit 2 and never echoes the token', async () => {
    const f = await fake([{ status: 401, body: { message: 'Bad credentials' } }]);
    const err = await getJson(recordingHttp(), f.url, { headers }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TrackerAuthError);
    expect((err as CliError).exitCode).toBe(2);
    expect((err as Error).message).toBe(
      'GitHub refused the credentials (401) — run `gh auth login`',
    );
    expect((err as Error).message).not.toContain('SECRETTOKEN');
  });

  it('a 404 or 410 is the caller’s to judge', async () => {
    const f = await fake([{ status: 404, body: { message: 'Not Found' } }]);
    expect(await getJson(recordingHttp(), f.url, { headers }, ctx)).toMatchObject({
      status: 404,
      json: null,
    });
  });

  it('an unreachable host names the host, not the request', async () => {
    const err = await getJson(recordingHttp(), 'http://127.0.0.1:1/x', { headers }, ctx).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(CliError);
    expect((err as Error).message).toMatch(/^cannot reach 127\.0\.0\.1:1: /);
    expect((err as Error).message).not.toContain('SECRETTOKEN');
  });
});
