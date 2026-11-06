import { describe, expect, it } from 'vitest';
import { waitForStopped } from './waitForStopped.mjs';

/**
 * Lane 01M6FJBY19: one transient Machines API error must not abort the 10-minute wait —
 * the deploy cleanup runs in a `finally`, so an abort destroys the migrate machine it was
 * waiting on, the harm lane 01M6FF11B1 fixed through the `fly machine wait` path.
 */

type Step = { status?: number; state?: string; error?: string } | 'throw';

function fakeFetch(steps: Step[]) {
  let calls = 0;
  const fetchImpl = async () => {
    const step = steps[Math.min(calls, steps.length - 1)] as Step;
    calls += 1;
    if (step === 'throw') throw new Error('socket hang up');
    const status = step.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ state: step.state, error: step.error }),
    };
  };
  return { fetchImpl, calls: () => calls };
}

const opts = (fetchImpl: unknown) => ({
  fetchImpl: fetchImpl as typeof fetch,
  pollMs: 1,
});

describe('waitForStopped', () => {
  it('resolves when the machine stops', async () => {
    const { fetchImpl } = fakeFetch([{ state: 'started' }, { state: 'stopped' }]);
    await expect(
      waitForStopped('tok', 'app', 'm1', 5_000, opts(fetchImpl)),
    ).resolves.toBeUndefined();
  });

  it('retries a thrown fetch and a transient 5xx inside the deadline', async () => {
    const { fetchImpl, calls } = fakeFetch([
      'throw',
      { status: 503, error: 'unavailable' },
      { state: 'started' },
      { state: 'stopped' },
    ]);
    await expect(
      waitForStopped('tok', 'app', 'm1', 5_000, opts(fetchImpl)),
    ).resolves.toBeUndefined();
    expect(calls()).toBe(4);
  });

  it('retries a 404 just after create, then resolves on stopped', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 404, error: 'not found' },
      { state: 'stopped' },
    ]);
    await expect(
      waitForStopped('tok', 'app', 'm1', 5_000, opts(fetchImpl)),
    ).resolves.toBeUndefined();
    expect(calls()).toBe(2);
  });

  it('throws at once on a fatal auth status instead of burning the deadline', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 403, error: 'forbidden' }]);
    await expect(waitForStopped('tok', 'app', 'm1', 5_000, opts(fetchImpl))).rejects.toThrow(/403/);
    expect(calls()).toBe(1);
  });

  it('throws only at the deadline when every fetch fails transiently', async () => {
    const { fetchImpl, calls } = fakeFetch(['throw']);
    await expect(waitForStopped('tok', 'app', 'm1', 25, opts(fetchImpl))).rejects.toThrow(
      /did not stop/,
    );
    expect(calls()).toBeGreaterThan(1);
  });

  it('throws at the deadline naming the last seen state', async () => {
    const { fetchImpl } = fakeFetch([{ state: 'started' }]);
    await expect(waitForStopped('tok', 'app', 'm1', 25, opts(fetchImpl))).rejects.toThrow(
      /state started/,
    );
  });
});
