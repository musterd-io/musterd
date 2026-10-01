import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openTestDriver, testCloudPools } from '../db/testing.js';
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
