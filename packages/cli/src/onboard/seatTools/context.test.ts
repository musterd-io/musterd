import { SeatToolsPolicySchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { memoryFs, type HarnessContext } from '../reconcile/context.js';
import { withSeatTools } from './context.js';

function ctx(): HarnessContext {
  return {
    worktreeRoot: '/w/no-binding-here',
    machineConfigRoot: '/m',
    env: {},
    fs: memoryFs(),
    proc: { pid: 1, startToken: () => 's', alive: () => true } as unknown as HarnessContext['proc'],
    clock: { now: () => 42 } as HarnessContext['clock'],
  };
}

describe('withSeatTools (ADR 794)', () => {
  it('puts the resolved set on the context', async () => {
    const policy = SeatToolsPolicySchema.parse({
      roles: { designer: { claude_plugins: ['figma@claude-plugins-official'] } },
    });
    const out = await withSeatTools(ctx(), {
      fetch: () => Promise.resolve(policy),
      roles: ['designer'],
    });
    expect(out.seatTools?.source).toBe('server');
    expect(out.seatTools?.readAt).toBe(42);
    expect(out.seatTools?.claude_plugins).toContain('figma@claude-plugins-official');
  });

  it('a folder with no seat binding resolves to repo tools and the floor, without throwing', async () => {
    const out = await withSeatTools(ctx());
    expect(out.seatTools?.source).toBe('none');
    expect(out.seatTools?.claude_plugins).toEqual([]);
  });
});
