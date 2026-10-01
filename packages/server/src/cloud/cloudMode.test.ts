import { existsSync, mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { SCHEMA_NEWER_SENTENCE, SCHEMA_OLDER_SENTENCE } from '../db/guard.js';
import { LADDER } from '../db/ladder.js';
import { openTestDriver, testCloudPools, type TestStore } from '../db/testing.js';
import { TRACE_LADDER } from '../db/traceLadder.js';
import { createServer } from '../index.js';
import { addMember } from '../store/members.js';
import { createTeam } from '../store/teams.js';
import { testIssuer } from './testIssuer.js';

/** The cloud env, pointed at nothing real: the pools come from `testCloudPools()`. */
export function stubCloudEnv(over: Record<string, string> = {}): void {
  const env: Record<string, string> = {
    MUSTERD_MODE: 'cloud',
    MUSTERD_DATABASE_APP_URL: 'postgres://app@db.test/musterd',
    MUSTERD_DATABASE_OPERATOR_URL: 'postgres://operator@db.test/musterd',
    MUSTERD_TRACE_DATABASE_APP_URL: 'postgres://app@db.test/musterd_trace',
    MUSTERD_TRACE_DATABASE_OPERATOR_URL: 'postgres://operator@db.test/musterd_trace',
    MUSTERD_CONSOLE_JWKS_URL: 'http://127.0.0.1:9/jwks',
    MUSTERD_CONSOLE_AUDIENCE: 'https://cloud.test',
    MUSTERD_CLOUD_HOST_SUFFIX: 'musterd.test',
    ...over,
  };
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
}

/** A listening cloud server over fresh PGlite stores, plus its operator-scoped seed handle.
 *  `fresh: false` joins the stores as they are (a second server on the same database). */
export async function bootCloud(over: Record<string, string> = {}, opts: { fresh?: boolean } = {}) {
  stubCloudEnv(over);
  const seed = opts.fresh === false ? null : await openTestDriver('pglite');
  if (opts.fresh !== false) await openTestDriver('pglite', { store: 'trace' });
  const s = createServer({
    cloudPools: (await testCloudPools()).factories,
    rosterRoots: [],
    port: 0,
  });
  await s.listen();
  return { s, seed, url: `http://127.0.0.1:${s.port}` };
}

describe('cloud mode — store selection (1C task 2)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('builds pgDriver for both stores from the cloud URLs and opens no SQLite file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-cloud-'));
    vi.stubEnv('MUSTERD_DB', join(dir, 'musterd.db'));
    vi.stubEnv('MUSTERD_TRACE_DB', join(dir, 'trace.db'));
    stubCloudEnv();
    const seed = await openTestDriver('pglite'); // fresh, operator-scoped, same PGlite the pools use
    await createTeam(seed, { slug: 'revive' });
    const pools = await testCloudPools();
    const s = createServer({ cloudPools: pools.factories, rosterRoots: [] });
    try {
      expect(s.store.dialect).toBe('postgres');
      expect(s.traceStore.dialect).toBe('postgres');
      expect(s.dbPath).toBe('postgres');
      // The same database the seed wrote: the server's store IS the configured Postgres.
      expect(await s.store.get<{ slug: string }>('SELECT slug FROM teams')).toEqual({
        slug: 'revive',
      });
      // …reached through the URLs cloud mode was given, operator for the operator handle.
      expect(pools.urls).toContain('postgres://operator@db.test/musterd');
      expect(existsSync(join(dir, 'musterd.db'))).toBe(false);
      expect(existsSync(join(dir, 'trace.db'))).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe('cloud mode — boot refuses a schema it does not match (1C task 3, spec §6)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const MAX: Record<TestStore, number> = {
    main: LADDER.at(-1)!.version,
    trace: TRACE_LADDER.at(-1)!.version,
  };

  /** Boot a cloud server with `store`'s schema_version set to `at`, restoring it afterwards. */
  async function bootAt(store: TestStore, at: number): Promise<unknown> {
    stubCloudEnv();
    const d = await openTestDriver('pglite', { store });
    await openTestDriver('pglite', { store: store === 'main' ? 'trace' : 'main' });
    const set = (v: number) =>
      d.run("UPDATE schema_meta SET value = ? WHERE key = 'schema_version'", [String(v)]);
    await set(at);
    const s = createServer({
      cloudPools: (await testCloudPools()).factories,
      rosterRoots: [],
      port: 0,
    });
    try {
      await s.listen();
      return 'served';
    } catch (e) {
      return (e as Error).message;
    } finally {
      await s.close();
      await set(MAX[store]);
    }
  }

  it("serves when both stores are at this build's version", async () => {
    expect(await bootAt('main', MAX.main)).toBe('served');
  });

  it.each<TestStore>(['main', 'trace'])(
    'refuses a %s schema NEWER than this build',
    async (store) => {
      expect(await bootAt(store, MAX[store] + 1)).toMatch(SCHEMA_NEWER_SENTENCE);
    },
  );

  it.each<TestStore>(['main', 'trace'])(
    'refuses a %s schema OLDER than this build — migration is a separate step',
    async (store) => {
      expect(await bootAt(store, MAX[store] - 1)).toMatch(SCHEMA_OLDER_SENTENCE);
    },
  );
});

describe('cloud mode — the machine verbs are not mounted (1C task 4, Decision 2)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('a loopback caller gets 404 from the store/node verbs, not the old localhost pass', async () => {
    const { s, url } = await bootCloud();
    try {
      for (const path of ['/store/prune', '/store/compact', '/node/enroll']) {
        const r = await fetch(url + path, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(r.status, path).toBe(404);
      }
    } finally {
      await s.close();
    }
  });
});

describe('cloud mode — creating a team takes a console token (1C task 5, spec §4.3 / §5.2)', () => {
  afterEach(() => vi.unstubAllEnvs());
  const AUD = 'https://cloud.test';
  const create = (url: string, token?: string) =>
    fetch(url + '/teams', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ slug: 'acme', creator: { name: 'ada' } }),
    });

  it('refuses POST /teams without a console token — the self-hosted open door is shut', async () => {
    const issuer = testIssuer();
    await issuer.serve();
    const { s, url } = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: issuer.url });
    try {
      expect((await create(url)).status).toBe(401);
      // A seat-style bearer is not a console token either.
      expect((await create(url, 'mscr_not_a_console_token')).status).toBe(401);
    } finally {
      await s.close();
      await issuer.close();
    }
  });

  it('one token creates once: replayed against a SECOND server on the same database, it is refused', async () => {
    const issuer = testIssuer();
    await issuer.serve();
    const a = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: issuer.url });
    const b = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: issuer.url }, { fresh: false });
    try {
      const token = issuer.token(AUD);
      const first = await create(a.url, token);
      expect(first.status).toBe(201);
      const second = await create(b.url, token);
      expect(second.status).toBe(401);
      expect(((await second.json()) as { error: { message: string } }).error.message).toMatch(
        /replayed/,
      );
      expect(await a.s.store.all('SELECT slug FROM teams')).toEqual([{ slug: 'acme' }]);
    } finally {
      await a.s.close();
      await b.s.close();
      await issuer.close();
    }
  });

  it('a token for another audience is refused', async () => {
    const issuer = testIssuer();
    await issuer.serve();
    const { s, url } = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: issuer.url });
    try {
      expect((await create(url, issuer.token('https://elsewhere.test'))).status).toBe(401);
    } finally {
      await s.close();
      await issuer.close();
    }
  });

  it('an unreachable console is a 503 with the stable sentence, not a 401', async () => {
    const issuer = testIssuer();
    const { s, url } = await bootCloud({ MUSTERD_CONSOLE_JWKS_URL: 'http://127.0.0.1:9/jwks' });
    try {
      const r = await create(url, issuer.token(AUD));
      expect(r.status).toBe(503);
      expect(((await r.json()) as { error: { message: string } }).error.message).toBe(
        'console unreachable',
      );
    } finally {
      await s.close();
    }
  });
});

/** An HTTP request with an explicit Host header (fetch will not send one it did not derive). */
export function hostRequest(
  url: string,
  path: string,
  host: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body: string }> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const r = request(
      {
        host: u.hostname,
        port: u.port,
        path,
        method: opts.method ?? 'GET',
        headers: { host, ...(opts.headers ?? {}) },
      },
      (res) => {
        let body = '';
        res.on('data', (c: Buffer) => (body += c.toString()));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    r.on('error', reject);
    r.end(opts.body);
  });
}

describe('cloud mode — a team host reaches only its own team (1C task 6, spec §5.3)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("HTTP: another team's routes are 404 on this team's host; its own answer", async () => {
    const { s, seed, url } = await bootCloud();
    try {
      const revive = await createTeam(seed!, { slug: 'revive' });
      await createTeam(seed!, { slug: 'other' });
      const { token } = await addMember(seed!, revive, { name: 'ada', kind: 'human', role: '' });
      const auth = { authorization: `Bearer ${token}` };
      const own = await hostRequest(url, '/teams/revive/members', 'revive.musterd.test', {
        headers: auth,
      });
      expect(own.status).toBe(200);
      // The SAME valid credential, sent to the other team's host: the host refuses before auth.
      const cross = await hostRequest(url, '/teams/revive/members', 'other.musterd.test', {
        headers: auth,
      });
      expect(cross.status).toBe(404);
      // A team route on a host that names no team at all.
      expect((await hostRequest(url, '/mcp/revive', 'musterd.test')).status).toBe(404);
      // Global routes answer on any host.
      expect((await hostRequest(url, '/health', 'other.musterd.test')).status).toBe(200);
    } finally {
      await s.close();
    }
  });

  it('WS: a claim for another team on this host is refused as not_found', async () => {
    const { s, seed, url } = await bootCloud();
    try {
      await createTeam(seed!, { slug: 'revive' });
      const frameOn = async (host: string) => {
        const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { host } });
        await new Promise((r, j) => (ws.once('open', r), ws.once('error', j)));
        const first = new Promise<{ type: string; code?: string }>((r) =>
          ws.once('message', (d) => r(JSON.parse(String(d)))),
        );
        ws.send(
          JSON.stringify({
            type: 'claim',
            v: PROTOCOL_VERSION,
            team: 'revive',
            key: 'mskey_bogus',
            target: { seat: 'ada' },
            surface: 'cli',
          }),
        );
        const f = await first;
        ws.close();
        return f;
      };
      expect(await frameOn('other.musterd.test')).toMatchObject({
        type: 'error',
        code: 'not_found',
      });
      // On its own host the same bogus claim gets past the host, as far as authentication
      // (a `refused` frame: the key is wrong), never `not_found`.
      expect(await frameOn('revive.musterd.test')).toMatchObject({ type: 'refused' });
    } finally {
      await s.close();
    }
  });
});
