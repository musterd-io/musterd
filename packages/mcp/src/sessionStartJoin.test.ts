import { describe, expect, it, vi } from 'vitest';
import { createAutojoinAttempt, scheduleSessionStartJoin } from './index.js';

describe('createAutojoinAttempt (ADR 707)', () => {
  it('runs once while the attempt succeeds, however many paths fire it', async () => {
    const run = vi.fn(async () => undefined);
    const attempt = createAutojoinAttempt(run);
    await Promise.all([attempt(), attempt(), attempt()]);
    await attempt();
    expect(run).toHaveBeenCalledOnce();
  });

  it('re-arms after a failure, so the next path retries', async () => {
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('daemon down'))
      .mockResolvedValue(undefined);
    const attempt = createAutojoinAttempt(run);
    await expect(attempt()).rejects.toThrow('daemon down');
    await expect(attempt()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe('scheduleSessionStartJoin (ADR 707)', () => {
  it('fires after the grace, not before', async () => {
    const run = vi.fn(async () => undefined);
    scheduleSessionStartJoin(run, 20);
    expect(run).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
  });

  it('a cancel inside the grace means the join never fires (the probe case)', async () => {
    const run = vi.fn(async () => undefined);
    const cancel = scheduleSessionStartJoin(run, 20);
    cancel();
    await new Promise((r) => setTimeout(r, 40));
    expect(run).not.toHaveBeenCalled();
  });

  it('a failed join is swallowed at this seam, never an adapter crash', async () => {
    const run = vi.fn(async () => {
      throw new Error('daemon down');
    });
    scheduleSessionStartJoin(run, 5);
    await vi.waitFor(() => expect(run).toHaveBeenCalledOnce());
    // No unhandled rejection: the test process surviving to this line is the assertion.
  });
});
