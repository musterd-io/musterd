import { describe, expect, it } from 'vitest';
import { openTestDriver } from '../db/testing.js';
import type { StoreSizes } from './retention.js';
import { healthStoreSizes, type MeasureStoreSizes } from './storeSizesHealth.js';

/**
 * `/health` must not wait on the sizes' `dbstat` walk (0.8 s warm, 15 s cold on the hub, 2026-10-12):
 * it answers from the last measurement and refreshes it in the background, once per TTL.
 */
describe('healthStoreSizes', () => {
  function harness(results: Array<StoreSizes | Error>) {
    let t = 1_000;
    const calls: number[] = [];
    let release: (() => void) | undefined;
    const measure: MeasureStoreSizes = () => {
      calls.push(t);
      const next = results.shift()!;
      return new Promise<StoreSizes>((resolve, reject) => {
        release = () => (next instanceof Error ? reject(next) : resolve(next));
      });
    };
    const settle = async () => {
      release?.();
      release = undefined;
      await new Promise((r) => setImmediate(r));
    };
    return {
      measure,
      calls,
      settle,
      advance: (ms: number) => (t += ms),
      now: () => t,
    };
  }

  it('answers at once without sync_log_bytes, then serves the background measurement', async () => {
    const db = await openTestDriver('sqlite');
    const h = harness([{ sync_log_rows: 7, sync_log_bytes: 4096 }]);
    const opts = { measure: h.measure, now: h.now, ttlMs: 60_000 };

    const first = await healthStoreSizes(db, ':memory:', null, opts);
    expect(first.sync_log_rows).toBe(0);
    expect(first).not.toHaveProperty('sync_log_bytes');
    expect(h.calls).toHaveLength(1);

    // Still measuring: the same quick answer, and no second measurement stacked on the first.
    expect(await healthStoreSizes(db, ':memory:', null, opts)).toEqual(first);
    expect(h.calls).toHaveLength(1);

    await h.settle();
    expect(await healthStoreSizes(db, ':memory:', null, opts)).toEqual({
      sync_log_rows: 7,
      sync_log_bytes: 4096,
    });
    await db.close();
  });

  it('measures again only once the TTL has passed', async () => {
    const db = await openTestDriver('sqlite');
    const h = harness([
      { sync_log_rows: 1, sync_log_bytes: 10 },
      { sync_log_rows: 2, sync_log_bytes: 20 },
    ]);
    const opts = { measure: h.measure, now: h.now, ttlMs: 60_000 };
    await healthStoreSizes(db, ':memory:', null, opts);
    await h.settle();

    h.advance(59_000);
    expect((await healthStoreSizes(db, ':memory:', null, opts)).sync_log_rows).toBe(1);
    expect(h.calls).toHaveLength(1);

    h.advance(2_000);
    // The stale value answers while the refresh runs; the next read sees the refresh.
    expect((await healthStoreSizes(db, ':memory:', null, opts)).sync_log_rows).toBe(1);
    expect(h.calls).toHaveLength(2);
    await h.settle();
    expect((await healthStoreSizes(db, ':memory:', null, opts)).sync_log_bytes).toBe(20);
    await db.close();
  });

  it('keeps the last value when a measurement fails, and waits a TTL before retrying', async () => {
    const db = await openTestDriver('sqlite');
    const h = harness([new Error('worker died'), { sync_log_rows: 3, sync_log_bytes: 30 }]);
    const opts = { measure: h.measure, now: h.now, ttlMs: 60_000 };
    const first = await healthStoreSizes(db, ':memory:', null, opts);
    await h.settle();
    expect(await healthStoreSizes(db, ':memory:', null, opts)).toEqual(first);
    expect(h.calls).toHaveLength(1);

    h.advance(60_000);
    await healthStoreSizes(db, ':memory:', null, opts);
    await h.settle();
    expect((await healthStoreSizes(db, ':memory:', null, opts)).sync_log_bytes).toBe(30);
    await db.close();
  });

  it('measures inline, as before, for an in-memory store with no measurer', async () => {
    const db = await openTestDriver('sqlite');
    const sizes = await healthStoreSizes(db, ':memory:', null);
    expect(sizes.sync_log_rows).toBe(0);
    await db.close();
  });
});
