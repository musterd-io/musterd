import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import {
  buildCursorAgentFreshArgs,
  buildCursorAgentResumeArgs,
  cursorAgentBackend,
  cursorAgentWakeEnv,
} from './cursorAgent.js';

class Child extends EventEmitter {
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  stdout?: EventEmitter;
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

describe('cursor-agent wake argv (2026.10.01-e373342; --output-format json on 2026.10.14-941492e)', () => {
  it('fresh is --trust --print --output-format json --approve-mcps --workspace, never --force or --yolo', () => {
    const args = buildCursorAgentFreshArgs('hello from the daemon', '/tmp/ws');
    expect(args).toEqual([
      '--trust',
      '--print',
      '--output-format',
      'json',
      '--approve-mcps',
      '--workspace',
      '/tmp/ws',
      'hello from the daemon',
    ]);
    expect(args.join(' ')).not.toMatch(/yolo|force|bypassPermissions/);
  });

  it('resume names the chat id and keeps the fresh flags', () => {
    expect(buildCursorAgentResumeArgs('line', 'chat-1', '/tmp/ws')).toEqual([
      '--trust',
      '--print',
      '--output-format',
      'json',
      '--approve-mcps',
      '--resume',
      'chat-1',
      '--workspace',
      '/tmp/ws',
      'line',
    ]);
  });
});

describe('cursorAgentBackend.wake', () => {
  it('defers when the binary is missing, and does not spawn', async () => {
    let spawned = false;
    const backend = cursorAgentBackend({
      resolveBin: async () => null,
      spawn: (() => {
        spawned = true;
        return new Child();
      }) as never,
    });
    const result = await backend.wake(spec, {
      verifyOccupied: async () => ({ occupied: true, lease_matched: true }),
      log: () => {},
    });
    expect(result.outcome).toMatchObject({
      occupied: false,
      deferred: true,
      reason: expect.stringContaining('cursor-agent CLI not found'),
    });
    expect(spawned).toBe(false);
    expect(await result.settled).toBeUndefined();
  });

  it('defers when a local cursor session is already live', async () => {
    let spawned = false;
    const backend = cursorAgentBackend({
      resolveBin: async () => '/cursor-agent',
      spawn: (() => {
        spawned = true;
        return new Child();
      }) as never,
      readSession: () => ({ state: 'live', source: 'enumerated' }) as never,
    });
    const result = await backend.wake(spec, {
      verifyOccupied: async () => ({ occupied: false }),
      log: () => {},
    });
    expect(result.outcome).toEqual({
      occupied: false,
      deferred: true,
      reason: 'local-session-live',
    });
    expect(spawned).toBe(false);
  });

  it('spawns fresh, settles injected tokens as harness_prints_no_price, and sets no cost_usd', async () => {
    const child = new Child();
    const lines: string[] = [];
    const seen: string[][] = [];
    const backend = cursorAgentBackend({
      resolveBin: async () => '/cursor-agent',
      spawn: ((_bin, args) => {
        seen.push(args as string[]);
        return child;
      }) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      readUsage: () => ({ input_tokens: 10, output_tokens: 2 }),
      findSessionId: () => 'chat-real',
    });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: (l) => lines.push(l),
    };
    const result = await backend.wake(spec, ctx);
    expect(seen).toEqual([buildCursorAgentFreshArgs('wake line', '/tmp/ws')]);
    expect(result.outcome).toEqual({ occupied: true, session: 'fresh' });
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.usage).toEqual({ input_tokens: 10, output_tokens: 2 });
    expect(completion?.cost_usd).toBeUndefined();
    expect(completion?.unpriced_reason).toBe('harness_prints_no_price');
    expect(completion?.captures).toEqual([
      { harness: 'cursor', ids: ['wake-l', undefined], id: 'chat-real' },
    ]);
    expect(lines.some((l) => /run for ada \(fresh\) settled: exit=0/.test(l))).toBe(true);
  });

  it('a wake that never verified still settles', async () => {
    const child = new Child();
    const backend = cursorAgentBackend({
      resolveBin: async () => '/cursor-agent',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      ensurePinned: () => undefined,
      readUsage: () => undefined,
      findSessionId: () => undefined,
    });
    const result = await backend.wake(spec, {
      verifyOccupied: async () => ({ occupied: false }),
      log: () => {},
    });
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.reason).toBe('no roster Presence attesting this wake lease');
    child.exit(1);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.usage).toBeUndefined();
    expect(completion?.cost_usd).toBeUndefined();
    expect(completion?.unpriced_reason).toBe('harness_price_unverified');
  });

  it('reads usage from JSON stdout when no reader is injected', async () => {
    const child = new Child();
    child.stdout = new EventEmitter();
    const backend = cursorAgentBackend({
      resolveBin: async () => '/cursor-agent',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      findSessionId: () => 'chat-real',
    });
    const result = await backend.wake(spec, {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: () => {},
    });
    child.stdout.emit(
      'data',
      Buffer.from(
        `${JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { inputTokens: 11, outputTokens: 4, cacheReadTokens: 7, cacheWriteTokens: 0 },
        })}\n`,
      ),
    );
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.usage).toEqual({
      input_tokens: 11,
      output_tokens: 4,
      cached_input_tokens: 7,
      cache_write_input_tokens: 0,
    });
    expect(completion?.cost_usd).toBeUndefined();
    expect(completion?.unpriced_reason).toBe('harness_prints_no_price');
  });

  it('resumes a captured cursor chat, and does not spawn fresh when that occupies', async () => {
    const child = new Child();
    const seen: string[][] = [];
    const backend = cursorAgentBackend({
      resolveBin: async () => '/cursor-agent',
      spawn: ((_bin, args) => {
        seen.push(args as string[]);
        return child;
      }) as never,
      readSession: () =>
        ({
          state: 'resumable',
          source: 'enumerated',
          session: { harness: 'cursor', id: 'chat-1', started_at: 1 },
        }) as never,
      ensurePinned: () => undefined,
      findSessionId: () => 'should-not-be-read-on-resume',
    });
    const result = await backend.wake(
      { ...spec, order: { ...order, intended_delivery: 'resume' } },
      {
        verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
        log: () => {},
      },
    );
    expect(seen).toEqual([buildCursorAgentResumeArgs('wake line', 'chat-1', '/tmp/ws')]);
    expect(result.outcome).toEqual({ occupied: true, session: 'resumed' });
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.captures).toEqual([
      { harness: 'cursor', ids: ['wake-l', 'chat-1'], id: undefined },
    ]);
  });
});

describe('cursor-agent wake env', () => {
  it('stamps the lease and harness, and drops everything outside the allowlist', () => {
    const env = cursorAgentWakeEnv(
      { HOME: '/h', PATH: '/bin', CURSOR_API_KEY: 'secret', MUSTERD_MODEL: 'composer' },
      'L42',
    );
    expect(env).toMatchObject({
      HOME: '/h',
      PATH: '/bin',
      MUSTERD_MODEL: 'composer',
      MUSTERD_WAKE_LEASE: 'L42',
      MUSTERD_WAKE_HARNESS: 'cursor',
      MUSTERD_PROVENANCE: 'wake',
    });
    expect(env['CURSOR_API_KEY']).toBeUndefined();
    expect(cursorAgentWakeEnv({ HOME: '/h' }).MUSTERD_WAKE_HARNESS).toBeUndefined();
  });
});

describe('cursor-agent wake-lease file', () => {
  const setup = (over: Partial<Parameters<typeof cursorAgentBackend>[0]> = {}) => {
    const child = new Child();
    const writes: Array<Record<string, unknown>> = [];
    const clears: string[] = [];
    const backend = cursorAgentBackend({
      resolveBin: async () => '/cursor-agent',
      spawn: (() => child) as never,
      readSession: () => ({ state: 'none', source: 'slot' }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      findSessionId: () => undefined,
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

  it('writes the lease naming the child, then rewrites it with the session cursor wrote', async () => {
    const { child, backend, ctx, writes, clears } = setup({ findSessionId: () => 'chat-9' });
    const result = await backend.wake(spec, ctx);
    expect(writes[0]).toMatchObject({ lease_id: 'l', harness: 'cursor', spawner_pid: 4242 });
    expect(writes[0]).not.toHaveProperty('session_id');
    expect(writes.at(-1)).toMatchObject({ session_id: 'chat-9' });
    child.exit(0);
    await result.settled;
    expect(clears).toEqual(['l']);
  });

  it('stamps the lease dream for a dream wake', async () => {
    const { child, backend, ctx, writes } = setup();
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
