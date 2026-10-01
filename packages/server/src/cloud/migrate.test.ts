import { describe, expect, it } from 'vitest';
import { LADDER } from '../db/ladder.js';
import { pgliteDriver } from '../db/pgliteDriver.js';
import { TRACE_LADDER } from '../db/traceLadder.js';
import { migrateCloud } from './migrate.js';

const SECRET = 'owner-sentinel';
const ENV = {
  MUSTERD_DATABASE_OWNER_URL: `postgres://owner:${SECRET}@direct.test/musterd`,
  MUSTERD_TRACE_DATABASE_OWNER_URL: `postgres://owner:${SECRET}@direct.test/musterd_trace`,
};

describe('migrateCloud (1C task 3, spec §6 — the separate migrate step)', () => {
  it('migrates both empty stores to this build, as the owner, and is idempotent', async () => {
    const main = await pgliteDriver();
    const trace = await pgliteDriver();
    const urls: string[] = [];
    const pools = {
      main: (u: string) => (urls.push(u), main.poolFactory()(u)),
      trace: (u: string) => (urls.push(u), trace.poolFactory()(u)),
    };
    try {
      const want = { main: LADDER.at(-1)!.version, trace: TRACE_LADDER.at(-1)!.version };
      expect(await migrateCloud(ENV, { pools })).toEqual(want);
      expect(await migrateCloud(ENV, { pools })).toEqual(want);
      // Only the owner URLs were used: migration never runs as the app or operator role.
      expect(new Set(urls)).toEqual(
        new Set([ENV.MUSTERD_DATABASE_OWNER_URL, ENV.MUSTERD_TRACE_DATABASE_OWNER_URL]),
      );
    } finally {
      await main.close();
      await trace.close();
    }
  });

  it('refuses without an owner URL, naming the variable and never echoing a value', async () => {
    await expect(
      migrateCloud({ MUSTERD_DATABASE_OWNER_URL: ENV.MUSTERD_DATABASE_OWNER_URL }),
    ).rejects.toThrow(/MUSTERD_TRACE_DATABASE_OWNER_URL/);
    await expect(
      migrateCloud({ ...ENV, MUSTERD_DATABASE_OWNER_URL: `mysql://x:${SECRET}@h/d` }),
    ).rejects.toThrow(/^(?!.*owner-sentinel).*MUSTERD_DATABASE_OWNER_URL/);
  });
});
