import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PROTOCOL_VERSION } from '@musterd/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import type { Driver } from '../db/driver.js';
import { SCHEMA_NEWER_SENTENCE, SCHEMA_OLDER_SENTENCE } from '../db/guard.js';
import { LADDER } from '../db/ladder.js';
import { openTestDriver, testCloudPools, type TestStore } from '../db/testing.js';
import { TRACE_LADDER } from '../db/traceLadder.js';
import { createServer } from '../index.js';
import { addMember, mintCredential } from '../store/members.js';
import type { TeamRow } from '../store/rows.js';
import { createTeam } from '../store/teams.js';
import { bootCloud, bootCloudWithOutage, hostRequest, stubCloudEnv } from './testing.js';
import { testIssuer } from './testIssuer.js';

/** A human seat's real credential (`mscr_`) — what authenticates a person on every route. */
async function humanCredential(db: Driver, team: TeamRow, name: string): Promise<string> {
  const { row } = await addMember(db, team, { name, kind: 'human', role: '' });
  return (await mintCredential(db, row.id)).credential;
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

describe('cloud mode — a team host reaches only its own team (1C task 6, spec §5.3)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("HTTP: another team's routes are 404 on this team's host; its own answer", async () => {
    const { s, seed, url } = await bootCloud();
    try {
      const revive = await createTeam(seed!, { slug: 'revive' });
      await createTeam(seed!, { slug: 'other' });
      const token = await humanCredential(seed!, revive, 'ada');
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

describe('cloud mode — /health says ok or one stable sentence (1C task 7, spec §5.5 / §7)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('is exactly {ok:true} when the databases answer — no path, counts, or build on Cloud', async () => {
    const { s, url } = await bootCloud();
    try {
      const r = await fetch(url + '/health');
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true });
    } finally {
      await s.close();
    }
  });

  it('database down: /health is 503 "database unreachable"; recovery is automatic', async () => {
    const { s, url, setDown } = await bootCloudWithOutage();
    try {
      setDown(true);
      const down = await fetch(url + '/health');
      expect(down.status).toBe(503);
      expect(await down.json()).toEqual({ ok: false, reason: 'database unreachable' });
      setDown(false);
      const up = await fetch(url + '/health');
      expect(up.status).toBe(200);
      expect(await up.json()).toEqual({ ok: true });
    } finally {
      await s.close();
    }
  });

  it('database down: a team route is a 503 with the same sentence, never a 500 or stale data', async () => {
    const { s, seed, url, setDown } = await bootCloudWithOutage();
    try {
      const revive = await createTeam(seed, { slug: 'revive' });
      const token = await humanCredential(seed, revive, 'ada');
      setDown(true);
      const r = await hostRequest(url, '/teams/revive/members', 'revive.musterd.test', {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.status).toBe(503);
      expect(JSON.parse(r.body)).toEqual({
        error: { code: 'server_error', message: 'database unreachable' },
      });
    } finally {
      setDown(false);
      await s.close();
    }
  });
});

describe('cloud mode — no team rows without a credential for that team (review I3, spec §4.3)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('the roster reads that were anonymous on a loopback daemon need a credential on Cloud', async () => {
    const { s, seed, url } = await bootCloud();
    try {
      const revive = await createTeam(seed!, { slug: 'revive' });
      const token = await humanCredential(seed!, revive, 'ada');
      for (const path of ['/teams/revive', '/teams/revive/members']) {
        const anon = await hostRequest(url, path, 'revive.musterd.test');
        expect(anon.status, `${path} anonymous`).toBe(401);
        expect(anon.body, `${path} leaks no member`).not.toContain('ada');
        const authed = await hostRequest(url, path, 'revive.musterd.test', {
          headers: { authorization: `Bearer ${token}` },
        });
        expect(authed.status, `${path} with a credential`).toBe(200);
      }
    } finally {
      await s.close();
    }
  });
});

describe('cloud mode — a look-alike discovery path reaches no team (review M1)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it("'/_well-known/…' is not OAuth discovery — 404 on any host, never another team's metadata", async () => {
    const { s, seed, url } = await bootCloud();
    try {
      await createTeam(seed!, { slug: 'revive' });
      await createTeam(seed!, { slug: 'other' });
      const tls = { 'x-forwarded-proto': 'https' };
      // The real path, on the right host, still answers (the edge terminated TLS).
      const real = await hostRequest(
        url,
        '/.well-known/oauth-authorization-server/other',
        'other.musterd.test',
        { headers: tls },
      );
      expect(real.status).toBe(200);
      for (const p of [
        '/_well-known/oauth-authorization-server/other',
        '/xwell-known/oauth-protected-resource/mcp/other',
        '/Xwell-known/openid-configuration/oauth/other',
      ]) {
        const r = await hostRequest(url, p, 'revive.musterd.test', { headers: tls });
        expect(r.status, p).toBe(404);
      }
    } finally {
      await s.close();
    }
  });
});

describe('cloud mode — a database blip at the token endpoint is a 503, never a dead grant (review I2)', () => {
  afterEach(() => vi.unstubAllEnvs());

  /** A cloud server whose coordination store drops the connection on statements matching `blip`. */
  async function bootWithBlip(blip: RegExp) {
    stubCloudEnv();
    const seed = await openTestDriver('pglite');
    await openTestDriver('pglite', { store: 'trace' });
    const pools = (await testCloudPools()).factories;
    const main = (u: string) => {
      const p = pools.main(u);
      return {
        connect: async () => {
          const c = await p.connect();
          return {
            query: (text: string, values?: unknown[]) =>
              blip.test(text)
                ? Promise.reject(
                    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
                  )
                : c.query(text, values),
            release: (err?: unknown) => c.release(err),
          };
        },
        end: () => p.end(),
      };
    };
    const s = createServer({ cloudPools: { ...pools, main }, rosterRoots: [], port: 0 });
    await s.listen();
    await createTeam(seed, { slug: 'revive' });
    return { s, url: `http://127.0.0.1:${s.port}` };
  }
  const CIMD = 'https://client.example/oauth/metadata.json';
  const token = (url: string, body: Record<string, string>) =>
    hostRequest(url, '/oauth/revive/token', 'revive.musterd.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-proto': 'https' },
      body: JSON.stringify(body),
    });
  const expectUnavailable = (r: { status: number; body: string }) => {
    expect(r.status, r.body).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({ error_description: 'database unreachable' });
  };

  it('the client lookup failing is not "unknown client" (invalid_client makes a client forget its registration)', async () => {
    const { s, url } = await bootWithBlip(/oauth_clients/);
    try {
      expectUnavailable(
        await token(url, {
          grant_type: 'refresh_token',
          refresh_token: 'msrt_x',
          client_id: 'mcp-client',
        }),
      );
    } finally {
      await s.close();
    }
  });

  it('refresh rotation failing is not invalid_grant (RFC 6749 clients discard the refresh token)', async () => {
    const { s, url } = await bootWithBlip(/oauth_tokens/);
    try {
      expectUnavailable(
        await token(url, { grant_type: 'refresh_token', refresh_token: 'msrt_x', client_id: CIMD }),
      );
    } finally {
      await s.close();
    }
  });

  it('code redemption failing is not invalid_grant either', async () => {
    const { s, url } = await bootWithBlip(/oauth_codes/);
    try {
      expectUnavailable(
        await token(url, {
          grant_type: 'authorization_code',
          code: 'mscode_x',
          redirect_uri: 'https://client.example/cb',
          client_id: CIMD,
          code_verifier: 'v'.repeat(43),
        }),
      );
    } finally {
      await s.close();
    }
  });
});
