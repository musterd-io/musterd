import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SCHEMA_NEWER_SENTENCE, SCHEMA_OLDER_SENTENCE } from '../db/guard.js';
import { LADDER } from '../db/ladder.js';
import { openTestDriver, testCloudPools, type TestStore } from '../db/testing.js';
import { TRACE_LADDER } from '../db/traceLadder.js';
import { createServer } from '../index.js';
import { createTeam } from '../store/teams.js';

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
