import { describe, expect, it } from 'vitest';
import { createServer, openDb, seedDawn, sqliteDriver } from '../index.js';

/**
 * Plan 1A Task 23 — behaviour-unchanged falsifier. The async Driver moved every store module; the
 * one surface a client reads without a Team is `/health`, and its key set is pinned here to the
 * pre-1A set, literally. A key that appears or vanishes fails this test, whichever driver is under it.
 */
const REQUIRED = [
  'ok',
  'v',
  'db',
  'schema',
  'trace_db',
  'trace_schema',
  'sync_log_rows',
  'connections',
  'epoch',
  'booted_at',
] as const;
/** Present only when the store is file-backed, a git checkout, or a live agent has acted. */
const OPTIONAL = [
  'trace_db_bytes',
  'db_bytes',
  'sync_log_bytes',
  'archive_bytes',
  'quietest_busy_ms',
  'build',
] as const;

describe('/health after the async Driver (plan 1A Task 23)', () => {
  it('serves exactly the pre-1A key set on a seeded in-memory store', async () => {
    const db = openDb(':memory:');
    const server = createServer({ db, port: 0 });
    await seedDawn(sqliteDriver(db));
    const { port } = await server.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      const keys = Object.keys(body);
      for (const k of REQUIRED) expect(keys, `missing ${k}`).toContain(k);
      const allowed = new Set<string>([...REQUIRED, ...OPTIONAL]);
      expect(keys.filter((k) => !allowed.has(k))).toEqual([]);
      expect(body['ok']).toBe(true);
      expect(body['db']).toBe(':memory:');
      expect(typeof body['schema']).toBe('number');
      expect(typeof body['sync_log_rows']).toBe('number');
      expect(typeof body['connections']).toBe('number');
    } finally {
      await server.close();
    }
  });
});
