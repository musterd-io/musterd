import { describe, expect, it } from 'vitest';
import { CalendarApiError, connectionProblem, createCalendarApi, normalizeServerUrl } from './api';

const conn = { server: 'http://laptop.tail.ts.net:4849/', team: 'revive', credential: 'mscr_x' };

function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit } = {}) {
  return async (url: string, init?: RequestInit) => {
    seen.url = url;
    if (init !== undefined) seen.init = init;
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  };
}

describe('normalizeServerUrl', () => {
  it('trims a trailing slash and refuses what is not an origin', () => {
    expect(normalizeServerUrl(' http://laptop.tail.ts.net:4849/ ')).toBe(
      'http://laptop.tail.ts.net:4849',
    );
    expect(() => normalizeServerUrl('laptop:4849')).toThrow(/http\(s\)/);
    expect(() => normalizeServerUrl('http://laptop:4849/live')).toThrow();
  });
});

describe('connectionProblem', () => {
  const ok = { server: 'http://laptop.tail.ts.net:4849', team: 'revive', credential: 'mscr_x' };
  it('passes a complete connection', () => {
    expect(connectionProblem(ok)).toBeNull();
  });
  it('requires every field — an empty team once reached the daemon as /teams//calendar', () => {
    expect(connectionProblem({ ...ok, server: ' ' })).toMatch(/Server is required/);
    expect(connectionProblem({ ...ok, team: '' })).toMatch(/Team is required/);
    expect(connectionProblem({ ...ok, credential: '  ' })).toMatch(/Credential is required/);
  });
  it('refuses plain http to an IP before iOS does, and names the fix', () => {
    expect(connectionProblem({ ...ok, server: 'http://100.100.246.14:4849' })).toMatch(
      /Tailscale name/,
    );
    expect(connectionProblem({ ...ok, server: 'https://100.100.246.14' })).toBeNull();
  });
});

describe('createCalendarApi', () => {
  it('sends the bearer credential to the team route and parses the list', async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const api = createCalendarApi(
      conn,
      fakeFetch(200, { entries: [], deleted: ['a'], now: 5 }, seen),
    );
    expect(await api.list(3)).toEqual({ entries: [], deleted: ['a'], now: 5 });
    expect(seen.url).toBe('http://laptop.tail.ts.net:4849/teams/revive/calendar?since=3');
    expect((seen.init?.headers as Record<string, string>).authorization).toBe('Bearer mscr_x');
  });

  it('turns a protocol error body into a typed refusal', async () => {
    const api = createCalendarApi(
      conn,
      fakeFetch(400, { error: { code: 'bad_request', message: 'url: url must be https' } }),
    );
    const err = await api.remove('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CalendarApiError);
    expect(err).toMatchObject({
      status: 400,
      code: 'bad_request',
      message: 'url: url must be https',
    });
  });

  it('names a non-protocol failure by its status', async () => {
    const api = createCalendarApi(conn, fakeFetch(502, '<html>bad gateway</html>'));
    await expect(api.list()).rejects.toMatchObject({ status: 502, code: null });
  });

  it('marks an unreachable daemon as offline, not as a refusal', async () => {
    const api = createCalendarApi(conn, async () => {
      throw new TypeError('Network request failed');
    });
    const err = (await api.list().catch((e: unknown) => e)) as CalendarApiError;
    expect(err.unreachable).toBe(true);
  });

  it('refuses an answer that is not the protocol shape', async () => {
    const api = createCalendarApi(conn, fakeFetch(200, { entries: 'nope' }));
    await expect(api.list()).rejects.toThrow();
  });
});
