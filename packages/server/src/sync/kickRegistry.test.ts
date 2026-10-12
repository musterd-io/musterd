import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import { openTestDriver } from '../db/testing.js';
import { Hub } from '../transport/hub.js';
import { kickSyncPull, startSyncPull } from './pull.js';
import { kickSyncPush, startSyncPush } from './push.js';

/**
 * The loops register their doorbell once, on the operator ctx; a request rings it from a ctx that
 * `teamCtx` spread around a DIFFERENT db handle (Postgres `forTeam()` mints a new handle per call).
 * Keyed on the handle, every kick missed on PGlite — main's full check was red from 2026-10-08 (the
 * push-on-write and fold-kick latency tests waited out the 60 s timer). SQLite's `forTeam()` returns
 * the same handle, which is why the default driver never showed it. This test forces the shape on any
 * driver: a ring from another handle must still run the loop's tick.
 */
describe('sync doorbells are keyed on the daemon, not on a db handle', () => {
  async function loopCtx() {
    const store = await openTestDriver('sqlite');
    let ticks = 0;
    const counting = (): Ctx['db'] =>
      new Proxy(store, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            ticks += 1;
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    const base: Ctx = {
      db: counting(),
      traceDb: store as unknown as Ctx['traceDb'],
      hub: new Hub(),
      config: resolveConfig(),
      rosterRoots: [],
    };
    return { base, other: (): Ctx => ({ ...base, db: counting() }), ticks: () => ticks };
  }
  const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('a push kick from another handle runs the push loop', async () => {
    const { base, other, ticks } = await loopCtx();
    const stop = startSyncPush(base);
    await settle(50);
    const before = ticks();
    kickSyncPush(other());
    await settle(500);
    stop();
    expect(ticks()).toBeGreaterThan(before);
  });

  it('a pull kick from another handle runs the pull loop', async () => {
    const { base, other, ticks } = await loopCtx();
    const stop = startSyncPull(base);
    await settle(50);
    const before = ticks();
    kickSyncPull(other());
    await settle(500);
    stop();
    expect(ticks()).toBeGreaterThan(before);
  });

  it('two daemons do not ring each other', async () => {
    const a = await loopCtx();
    const b = await loopCtx();
    const stopA = startSyncPush(a.base);
    const stopB = startSyncPush(b.base);
    await settle(50);
    const beforeB = b.ticks();
    kickSyncPush(a.other());
    await settle(500);
    stopA();
    stopB();
    expect(b.ticks()).toBe(beforeB);
  });
});
