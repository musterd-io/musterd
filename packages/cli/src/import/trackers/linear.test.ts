import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliError } from '../../errors.js';
import type { TrackerHttp } from './http.js';
import { linearKey, linearSource } from './linear.js';

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

let server: Server | undefined;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

type Gql = { query: string; variables: Record<string, unknown> };
type Answer = { status?: number; body: string };

/** A Linear GraphQL fake: every request is a POST of `{query, variables}`. */
async function fakeLinear(answer: (q: Gql, auth: string | undefined) => Answer): Promise<string> {
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c.toString()));
    req.on('end', () => {
      const a = answer(JSON.parse(raw) as Gql, req.headers.authorization);
      res.writeHead(a.status ?? 200, { 'content-type': 'application/json' });
      res.end(a.body);
    });
  });
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/graphql`;
}

const http: TrackerHttp = { fetch, sleep: async () => {} };
const KEY = 'lin_api_SECRETKEY123';
const src = (endpoint: string) => linearSource({ team: 'ENG', key: KEY, http, endpoint });
const gqlError = (message: string, code: string) =>
  JSON.stringify({ errors: [{ message, extensions: { code } }] });

describe('linearSource.open', () => {
  it('pages on pageInfo, groups by project else cycle, and maps priority', async () => {
    const seen: Gql[] = [];
    const endpoint = await fakeLinear((q, auth) => {
      expect(auth).toBe(KEY);
      seen.push(q);
      return {
        body: fixture(q.variables['after'] ? 'linear-issues-p2.json' : 'linear-issues-p1.json'),
      };
    });
    const issues = await src(endpoint).open();
    expect(seen.map((q) => q.variables)).toEqual([
      { team: 'ENG', after: null },
      { team: 'ENG', after: 'cursor-1' },
    ]);
    expect(seen[0]!.query).toMatch(/nin: \["completed", "canceled"\]/);
    expect(issues).toEqual([
      {
        ref: 'ENG-12',
        title: 'Login fails on Safari',
        url: 'https://linear.app/acme/issue/ENG-12/login-fails-on-safari',
        body: 'Steps: open the login page in Safari 18.',
        group: { key: '8f1c2a4e-1111-4b6a-9d7e-0a1b2c3d4e5f', title: 'First release' },
        stakes: 'high',
      },
      {
        ref: 'ENG-15',
        title: 'Write the install guide',
        url: 'https://linear.app/acme/issue/ENG-15/write-the-install-guide',
        group: { key: 'cycle-7', title: 'Cycle 7' },
        stakes: 'low',
      },
      { ref: 'ENG-16', title: 'Dark mode', url: 'https://linear.app/acme/issue/ENG-16/dark-mode' },
    ]);
  });

  it('stops at the limit, and an empty team is an empty list', async () => {
    let endpoint = await fakeLinear(() => ({ body: fixture('linear-issues-p1.json') }));
    expect((await src(endpoint).open(1)).map((i) => i.ref)).toEqual(['ENG-12']);
    await new Promise<void>((r) => server!.close(() => r()));
    endpoint = await fakeLinear(() => ({
      body: JSON.stringify({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
      }),
    }));
    expect(await src(endpoint).open()).toEqual([]);
  });

  it('a refused key is exit 2 and never echoes the key', async () => {
    const endpoint = await fakeLinear(() => ({
      status: 400,
      body: gqlError('Authentication required, not authenticated', 'AUTHENTICATION_ERROR'),
    }));
    const err = (await src(endpoint)
      .open()
      .catch((e: unknown) => e)) as CliError;
    expect(err.exitCode).toBe(2);
    expect(err.message).toMatch(/^Linear refused the key — /);
    expect(err.message).not.toContain('SECRETKEY');
  });

  it('a team key Linear does not know says so', async () => {
    const endpoint = await fakeLinear(() => ({
      body: JSON.stringify({
        data: { issues: { nodes: [], pageInfo: { hasNextPage: false } } },
        errors: [{ message: 'oops', extensions: { code: 'INTERNAL' } }],
      }),
    }));
    await expect(src(endpoint).open()).rejects.toThrow(/^Linear: oops/);
  });
});

describe('linear identifiers are checked', () => {
  it('an identifier that is not <TEAM>-<n> stops the fetch', async () => {
    const endpoint = await fakeLinear(() => ({
      body: JSON.stringify({
        data: {
          issues: {
            nodes: [{ identifier: 'OPS-1', title: 't', url: 'https://linear.app/x' }],
            pageInfo: { hasNextPage: false },
          },
        },
      }),
    }));
    await expect(src(endpoint).open()).rejects.toThrow(
      /Linear sent an issue identifier that is not ENG-<number>/,
    );
  });
});

describe('linearSource.state', () => {
  it('completed/canceled are closed; not found, moved and archived are not_found', async () => {
    const endpoint = await fakeLinear((q) => {
      const id = q.variables['id'];
      const issue = (identifier: string, type: string, archivedAt: string | null = null) =>
        JSON.stringify({ data: { issue: { identifier, archivedAt, state: { type } } } });
      if (id === 'ENG-1') return { body: issue('ENG-1', 'completed') };
      if (id === 'ENG-2') return { body: issue('ENG-2', 'canceled') };
      if (id === 'ENG-3') return { body: issue('ENG-3', 'started') };
      if (id === 'ENG-4') return { body: issue('OPS-9', 'started') };
      if (id === 'ENG-5') return { body: issue('ENG-5', 'backlog', '2026-10-01T00:00:00Z') };
      return { body: gqlError('Entity not found: Issue', 'INVALID_INPUT') };
    });
    const s = src(endpoint);
    expect(await s.state('ENG-1')).toBe('closed');
    expect(await s.state('ENG-2')).toBe('closed');
    expect(await s.state('ENG-3')).toBe('open');
    expect(await s.state('ENG-4')).toBe('not_found');
    expect(await s.state('ENG-5')).toBe('not_found');
    expect(await s.state('ENG-6')).toBe('not_found');
  });

  it('owns only this team’s identifiers', () => {
    const s = linearSource({ team: 'ENG', key: 'k' });
    expect(s.ownsRef('ENG-42')).toBe(true);
    expect(s.ownsRef('ENGX-42')).toBe(false);
    expect(s.ownsRef('acme/app#42')).toBe(false);
  });
});

describe('linearKey', () => {
  it('reads LINEAR_API_KEY, else exit 2 with where to make one', () => {
    expect(linearKey({ LINEAR_API_KEY: ' lin_api_x ' })).toBe('lin_api_x');
    let err: CliError | undefined;
    try {
      linearKey({});
    } catch (e) {
      err = e as CliError;
    }
    expect(err?.exitCode).toBe(2);
    expect(err?.message).toBe(
      'no Linear key — create one in Linear (Settings → API) and set LINEAR_API_KEY',
    );
  });
});
