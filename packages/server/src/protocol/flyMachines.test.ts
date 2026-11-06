import { describe, expect, it } from 'vitest';
import { FlyApiError, flyMachinesClient } from './flyMachines.js';

/** ADR 816: the wire shape the fly watch spends — three calls, one fixed origin, token never echoed. */

function fakeFetch(steps: { status?: number; body?: unknown }[]) {
  const seen: { url: string; method: string; auth: string | undefined }[] = [];
  let calls = 0;
  const fetchImpl = async (
    url: string,
    init?: { method?: string; headers?: Record<string, string> },
  ) => {
    const step = steps[Math.min(calls, steps.length - 1)]!;
    calls += 1;
    seen.push({ url, method: init?.method ?? 'GET', auth: init?.headers?.authorization });
    const status = step.status ?? 200;
    return { ok: status >= 200 && status < 300, status, json: async () => step.body ?? {} };
  };
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen, calls: () => calls };
}

describe('flyMachinesClient (ADR 816)', () => {
  it('reads the machine state from the Machines API with the bearer token', async () => {
    const { fetchImpl, seen } = fakeFetch([{ body: { state: 'started' } }]);
    const fly = flyMachinesClient('tok-123', fetchImpl);
    await expect(fly.machineState('app-a', 'm1')).resolves.toBe('started');
    expect(seen[0]).toEqual({
      url: 'https://api.machines.dev/v1/apps/app-a/machines/m1',
      method: 'GET',
      auth: 'Bearer tok-123',
    });
  });

  it('reads a 404 as an unknown machine, not a failure', async () => {
    const { fetchImpl } = fakeFetch([{ status: 404, body: { error: 'not found' } }]);
    await expect(flyMachinesClient('t', fetchImpl).machineState('a', 'm')).resolves.toBeNull();
  });

  it('starts and stops via the machine action endpoints', async () => {
    const { fetchImpl, seen } = fakeFetch([{}, {}]);
    const fly = flyMachinesClient('t', fetchImpl);
    await fly.startMachine('app-a', 'm1');
    await fly.stopMachine('app-a', 'm1');
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      'POST https://api.machines.dev/v1/apps/app-a/machines/m1/start',
      'POST https://api.machines.dev/v1/apps/app-a/machines/m1/stop',
    ]);
  });

  it('surfaces the HTTP status on failure and never the token', async () => {
    const { fetchImpl } = fakeFetch([{ status: 503, body: { error: 'unavailable' } }]);
    const fly = flyMachinesClient('secret-token', fetchImpl);
    const err = await fly.startMachine('app-a', 'm1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FlyApiError);
    expect((err as FlyApiError).status).toBe(503);
    expect(String(err)).not.toContain('secret-token');
  });
});
