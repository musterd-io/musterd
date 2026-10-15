import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import { buildGrokFreshArgs, buildGrokResumeArgs, grokBackend, grokWakeEnv } from './grok.js';

class Child extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  kill(): boolean {
    return true;
  }
  exit(code = 0) {
    this.exitCode = code;
    this.emit('exit', code);
  }
}
const order: WakeOrder = {
  lease_id: 'l',
  seat: 'ada',
  act_id: 'a',
  act: 'steer',
  sender: 'lin',
  lane: 'immediate',
  composed_line: 'wake line',
  expires_at: Date.now() + 1_000,
  intended_delivery: 'fresh',
};
const spec: WakeSpec = {
  order,
  team: 't',
  server: 'http://127.0.0.1:1',
  workspace: '/tmp/ws',
  bounds: { timeout_ms: 5_000 },
};

describe('grok wake argv (ADR 352 §7, ADR 473 --trust)', () => {
  it('fresh is --trust -p with --cwd, never --yolo', () => {
    const args = buildGrokFreshArgs('hello from the daemon', '/tmp/ws');
    expect(args).toEqual(['--trust', '-p', 'hello from the daemon', '--cwd', '/tmp/ws']);
    expect(args.join(' ')).not.toMatch(/yolo|always-approve|bypassPermissions/);
  });

  it('resume is -r <id> plus the same fresh shape', () => {
    expect(buildGrokResumeArgs('line', '01abc', '/tmp/ws')).toEqual([
      '--trust',
      '-p',
      'line',
      '-r',
      '01abc',
      '--cwd',
      '/tmp/ws',
    ]);
  });
});

describe('grok settle (ADR 436 clause 1 — every wake settles and prices)', () => {
  it('settled carries duration_ms, the settle line, usage when Grok wrote one, and the unpriced reason', async () => {
    const child = new Child();
    const lines: string[] = [];
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      readUsage: () => ({ input_tokens: 10, output_tokens: 2 }),
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: (l) => lines.push(l),
    };
    const result = await backend.wake(spec, ctx);
    expect(result.outcome).toEqual({ occupied: true, session: 'fresh' });
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(completion?.unpriced_reason).toBe('harness_price_unverified');
    expect(lines.some((l) => /run for ada \(fresh\) settled: exit=0/.test(l))).toBe(true);
  });
  it('a wake that never verified still settles with a duration (no silent hole)', async () => {
    const child = new Child();
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      ensurePinned: () => undefined,
      readUsage: () => undefined,
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: false }),
      log: () => {},
    };
    const result = await backend.wake(spec, ctx);
    expect(result.outcome.occupied).toBe(false);
    child.exit(1);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.usage).toBeUndefined();
  });
});

describe('grok liveness (ADR 436 clause 4 — a wake that settled is over)', () => {
  it('settles claiming the wake-<lease> placeholder, renamed to the real Grok session id', async () => {
    const child = new Child();
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      readUsage: () => undefined,
      findSessionId: () => 'grok-real',
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: () => {},
    };
    const result = await backend.wake(spec, ctx);
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.captures).toEqual([
      { harness: 'grok', ids: ['wake-l', undefined], id: 'grok-real' },
    ]);
  });
});

describe('grok R2 at wake exit (lane 01M3R8G033 — a headless wake fires no session_end)', () => {
  it('the settled wake tails its own Grok transcript, for the real session id, in the workspace', async () => {
    const child = new Child();
    const tails: { workspace: string; sessionId: string }[] = [];
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      readUsage: () => undefined,
      findSessionId: () => 'grok-real',
      tailSession: async (workspace, sessionId) => {
        tails.push({ workspace, sessionId });
      },
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: () => {},
    };
    const result = await backend.wake(spec, ctx);
    expect(tails).toEqual([]); // not before the child exits
    child.exit(0);
    await result.settled;
    expect(tails).toEqual([{ workspace: '/tmp/ws', sessionId: 'grok-real' }]);
  });

  it('no session id found: nothing is tailed, and the wake still settles', async () => {
    const child = new Child();
    let tailed = false;
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      readUsage: () => undefined,
      findSessionId: () => undefined,
      tailSession: async () => {
        tailed = true;
      },
    });
    const result = await backend.wake(spec, {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: () => {},
    });
    child.exit(0);
    expect((await result.settled)?.duration_ms).toBeTypeOf('number');
    expect(tailed).toBe(false);
  });
});

describe('grok capture (ADR 436 clause 3 — the spawned harness is stamped at spawn)', () => {
  it('stamps MUSTERD_WAKE_HARNESS=grok beside the lease, and nothing without one', () => {
    expect(grokWakeEnv({ HOME: '/h' }, 'L42')).toMatchObject({
      MUSTERD_WAKE_LEASE: 'L42',
      MUSTERD_WAKE_HARNESS: 'grok',
    });
    expect(grokWakeEnv({ HOME: '/h' }).MUSTERD_WAKE_HARNESS).toBeUndefined();
  });
});

describe('grok wake-lease file (ADR 546 — the launcher can find this wake)', () => {
  const setup = (over: Partial<Parameters<typeof grokBackend>[0]> = {}) => {
    const child = new Child();
    const writes: Array<Record<string, unknown>> = [];
    const clears: string[] = [];
    const backend = grokBackend({
      resolveBin: async () => '/grok',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      readUsage: () => undefined,
      findSessionId: () => undefined,
      tailSession: async () => undefined,
      lease: {
        write: (_ws, lease) => writes.push(lease as unknown as Record<string, unknown>),
        clear: (_ws, id) => clears.push(id),
        takeYield: () => false,
      },
      ...over,
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: () => {},
    };
    return { child, backend, ctx, writes, clears };
  };

  it('writes the lease naming the child, then rewrites it with the session Grok wrote', async () => {
    const { child, backend, ctx, writes, clears } = setup({ findSessionId: () => 'G-9' });
    const result = await backend.wake(spec, ctx);
    expect(writes[0]).toMatchObject({ lease_id: 'l', harness: 'grok', spawner_pid: 4242 });
    expect(writes[0]).not.toHaveProperty('session_id');
    expect(writes.at(-1)).toMatchObject({ session_id: 'G-9' });
    child.exit(0);
    await result.settled;
    expect(clears).toEqual(['l']);
  });

  it('stamps the lease dream for a dream wake (ADR 604)', async () => {
    const { child, backend, ctx, writes } = setup({ findSessionId: () => undefined });
    const result = await backend.wake(
      { ...spec, order: { ...spec.order, derivation: 'dream' } },
      ctx,
    );
    expect(writes[0]).toMatchObject({ lease_id: 'l', provenance: 'dream' });
    child.exit(0);
    await result.settled;
  });

  it('a taken-over run settles as yielded', async () => {
    const { child, backend, ctx } = setup({
      lease: { write: () => {}, clear: () => {}, takeYield: () => true },
    });
    const result = await backend.wake(spec, ctx);
    child.exit(0);
    expect((await result.settled)?.yielded).toBe(true);
  });
});
