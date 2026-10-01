import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { insertFootprintTick, latestFootprint, pruneFootprint } from './footprint.js';

let openStore: () => Promise<Driver>;

withDrivers('footprint', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('footprint store (seat-footprint design)', async () => {
    it('round-trips a tick and returns only the latest one', async () => {
      const db = await openStore();
      await insertFootprintTick(
        db,
        [
          {
            ts: 1000,
            classification: 'orphaned',
            seat: null,
            procs: 41,
            rss_kb: 600_000,
            pids: '[1,2]',
          },
        ],
        { ts: 1000, swap_used_mb: 9000, swap_total_mb: 11264, free_mem_mb: 120 },
      );
      await insertFootprintTick(
        db,
        [{ ts: 2000, classification: 'live', seat: 'kimi', procs: 3, rss_kb: 90_000, pids: '[7]' }],
        { ts: 2000, swap_used_mb: 8000, swap_total_mb: 11264, free_mem_mb: 300 },
      );
      const latest = await latestFootprint(db);
      expect(latest).not.toBeNull();
      expect(latest!.ts).toBe(2000);
      expect(latest!.stacks).toHaveLength(1);
      expect(latest!.stacks[0]).toMatchObject({ classification: 'live', seat: 'kimi', procs: 3 });
      expect(latest!.machine.swap_used_mb).toBe(8000);
    });

    it('a machine-only tick (zero sidecar stacks) is still a tick', async () => {
      const db = await openStore();
      await insertFootprintTick(db, [], {
        ts: 5000,
        swap_used_mb: 1000,
        swap_total_mb: 2048,
        free_mem_mb: 1700,
      });
      const latest = await latestFootprint(db);
      expect(latest!.ts).toBe(5000);
      expect(latest!.stacks).toEqual([]);
    });

    it('prunes ticks older than the cutoff and reports the machine-row count', async () => {
      const db = await openStore();
      await insertFootprintTick(
        db,
        [{ ts: 1000, classification: 'live', seat: null, procs: 1, rss_kb: 1, pids: '[]' }],
        { ts: 1000, swap_used_mb: null, swap_total_mb: null, free_mem_mb: null },
      );
      await insertFootprintTick(db, [], {
        ts: 2000,
        swap_used_mb: null,
        swap_total_mb: null,
        free_mem_mb: null,
      });
      expect(await pruneFootprint(db, 1500)).toBe(1);
      const latest = await latestFootprint(db);
      expect(latest!.ts).toBe(2000);
      // The pruned tick's stack rows go with it.
      expect(
        (await db.get('SELECT COUNT(*) AS n FROM footprint_stacks')) as { n: number },
      ).toMatchObject({ n: 0 });
    });

    it('an empty table reads as null, not a fabricated tick', async () => {
      const db = await openStore();
      expect(await latestFootprint(db)).toBeNull();
    });
  });
});
