import { describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import { createSharedRead, sharedRosterBase } from './rosterCache.js';

describe('createSharedRead (ADR 541)', () => {
  function harness(ttlMs = 1_000) {
    let t = 0;
    let loads = 0;
    const read = createSharedRead<number>({ ttlMs, now: () => t });
    const load = async () => {
      loads += 1;
      return loads;
    };
    return {
      read,
      load,
      loads: () => loads,
      advance: (ms: number) => {
        t += ms;
      },
    };
  }

  it('one load serves every reader of a team inside the window', async () => {
    const h = harness();
    expect(await h.read.get('team-a', h.load)).toBe(1);
    h.advance(999);
    expect(await h.read.get('team-a', h.load)).toBe(1);
    expect(h.loads()).toBe(1);
  });

  it('a reader past the window waits for a fresh load — never served stale', async () => {
    const h = harness();
    await h.read.get('team-a', h.load);
    h.advance(1_000);
    expect(await h.read.get('team-a', h.load)).toBe(2);
  });

  it('concurrent readers join the load in flight', async () => {
    const h = harness();
    const [a, b, c] = await Promise.all([
      h.read.get('team-a', h.load),
      h.read.get('team-a', h.load),
      h.read.get('team-a', h.load),
    ]);
    expect([a, b, c]).toEqual([1, 1, 1]);
    expect(h.loads()).toBe(1);
  });

  it('teams never share a value', async () => {
    const h = harness();
    expect(await h.read.get('team-a', h.load)).toBe(1);
    expect(await h.read.get('team-b', h.load)).toBe(2);
  });

  it('a failed load is not cached; the next reader retries', async () => {
    const h = harness();
    await expect(
      h.read.get('team-a', async () => {
        throw new Error('db down');
      }),
    ).rejects.toThrow('db down');
    expect(await h.read.get('team-a', h.load)).toBe(1);
  });

  it('the window is measured from when the load started, not when it finished', async () => {
    const h = harness();
    await h.read.get('team-a', async () => {
      h.advance(600); // a slow load eats into its own freshness
      return h.load();
    });
    h.advance(500);
    expect(await h.read.get('team-a', h.load)).toBe(2);
  });
});

describe('sharedRosterBase (ADR 573)', () => {
  const cfg = (mode: string) => ({ mode }) as unknown as Ctx['config'];
  function counter() {
    let loads = 0;
    return { load: async () => ++loads, loads: () => loads };
  }

  it('cloud: one load serves every roster read of a team inside the window', async () => {
    const ctx = { config: cfg('cloud') };
    const c = counter();
    expect(await sharedRosterBase(ctx, 't1', c.load)).toBe(1);
    expect(await sharedRosterBase(ctx, 't1', c.load)).toBe(1);
    expect(c.loads()).toBe(1);
  });

  it('cloud: teams never share a load', async () => {
    const ctx = { config: cfg('cloud') };
    const c = counter();
    await sharedRosterBase(ctx, 't1', c.load);
    expect(await sharedRosterBase(ctx, 't2', c.load)).toBe(2);
  });

  it('cloud: a fresh read (a route that just wrote) bypasses the window', async () => {
    const ctx = { config: cfg('cloud') };
    const c = counter();
    await sharedRosterBase(ctx, 't1', c.load);
    expect(await sharedRosterBase(ctx, 't1', c.load, { fresh: true })).toBe(2);
  });

  it('a local daemon loads on every read, as before', async () => {
    const ctx = { config: cfg('local') };
    const c = counter();
    await sharedRosterBase(ctx, 't1', c.load);
    expect(await sharedRosterBase(ctx, 't1', c.load)).toBe(2);
  });
});
