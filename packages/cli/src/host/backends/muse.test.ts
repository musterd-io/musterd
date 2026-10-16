import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import { buildMuseFreshArgs, buildMuseResumeArgs, museBackend, museWakeEnv } from './muse.js';

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

function setup(over: Record<string, unknown> = {}) {
  const child = new Child();
  const writes: Array<Record<string, unknown>> = [];
  const clears: string[] = [];
  const backend = museBackend({
    resolveBin: async () => '/muse',
    spawn: (() => child) as never,
    readSession: () => ({ state: 'none', source: 'slot' }) as never,
    recordFreshSession: () => undefined,
    ensurePinned: () => undefined,
    newSessionId: () => 'ses-new-uuid',
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
}

describe('muse wake argv (ADR 619)', () => {
  it('fresh is exec with approval posture + trust + json + session id, never --yolo', () => {
    const args = buildMuseFreshArgs('hello from the daemon', '/tmp/ws', { sessionId: 's1' });
    expect(args).toEqual([
      'exec',
      '--disable-approval',
      '--trust-workspace',
      '--json',
      '--session-id',
      's1',
      'hello from the daemon',
    ]);
    expect(args.join(' ')).not.toMatch(/yolo|always-approve|bypassPermissions/);
  });

  it('resume adds the session id and the workspace switch', () => {
    expect(buildMuseResumeArgs('line', '01abc', '/tmp/ws', {})).toEqual([
      'exec',
      '--disable-approval',
      '--trust-workspace',
      '--json',
      '--session-id',
      '01abc',
      '--allow-workspace-switch',
      'line',
    ]);
  });

  it('max turns cap the model steps', () => {
    expect(buildMuseFreshArgs('line', '/tmp/ws', { sessionId: 's1', maxSteps: 25 })).toContain(
      '--max-model-steps',
    );
  });
});

describe('muse wake env (ADR 619)', () => {
  it('passes a bounded allowlist plus the lease, never the whole host env', () => {
    const env = museWakeEnv(
      { HOME: '/h', PATH: '/p', SECRET_STUFF: 'x', META_API_KEY: 'k' } as NodeJS.ProcessEnv,
      'l',
      undefined,
    );
    expect(env['HOME']).toBe('/h');
    expect(env['MUSTERD_WAKE_LEASE']).toBe('l');
    expect(env['MUSTERD_PROVENANCE']).toBe('wake');
    expect(env['MUSTERD_WAKE_HARNESS']).toBe('muse');
    expect(env['SECRET_STUFF']).toBeUndefined();
    expect(env['META_API_KEY']).toBeUndefined();
  });
});

describe('museBackend.wake', () => {
  it('defers when no binary resolves', async () => {
    const backend = museBackend({ resolveBin: async () => null });
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: false }),
      log: () => {},
    };
    const result = await backend.wake(spec, ctx);
    expect(result.outcome).toMatchObject({ occupied: false, deferred: true });
  });

  it('defers when a local session is live', async () => {
    const { backend, ctx } = setup({
      readSession: () => ({ state: 'live', source: 'slot' }) as never,
    });
    const result = await backend.wake(spec, ctx);
    expect(result.outcome).toMatchObject({ occupied: false, deferred: true });
  });

  it('writes the lease naming the child with the session id up front, and clears at settle', async () => {
    const { child, backend, ctx, writes, clears } = setup();
    const result = await backend.wake(spec, ctx);
    expect(result.outcome).toEqual({ occupied: true, session: 'fresh' });
    expect(writes[0]).toMatchObject({
      lease_id: 'l',
      harness: 'muse',
      spawner_pid: 4242,
      session_id: 'ses-new-uuid',
      provenance: 'wake',
    });
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.unpriced_reason).toBe('harness_price_unverified');
    expect(completion?.captures).toEqual([
      { harness: 'muse', ids: ['wake-l', 'ses-new-uuid'], id: 'ses-new-uuid' },
    ]);
    expect(clears).toEqual(['l']);
  });

  it('stamps the lease dream for a dream wake (ADR 604)', async () => {
    const { child, backend, writes } = setup();
    const dreamSpec: WakeSpec = {
      ...spec,
      order: { ...spec.order, derivation: 'dream' },
    };
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'dream', lease_matched: true }),
      log: () => {},
    };
    const result = await backend.wake(dreamSpec, ctx);
    expect(result.outcome.occupied).toBe(true);
    expect(writes[0]).toMatchObject({ provenance: 'dream' });
    child.exit(0);
    await result.settled;
  });

  it('resumes a captured muse session before trying fresh', async () => {
    const child = new Child();
    const seen: string[][] = [];
    const backend = museBackend({
      resolveBin: async () => '/muse',
      spawn: ((_bin: string, args: string[], _opts: unknown) => {
        seen.push(args);
        return child;
      }) as never,
      readSession: () =>
        ({
          state: 'resumable',
          source: 'slot',
          session: { harness: 'muse', id: 'ses-old' },
        }) as never,
      recordFreshSession: () => undefined,
      ensurePinned: () => undefined,
      newSessionId: () => 'ses-new-uuid',
    });
    const resumeSpec: WakeSpec = {
      ...spec,
      order: { ...spec.order, intended_delivery: 'portable' },
    };
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
      log: () => {},
    };
    const result = await backend.wake(resumeSpec, ctx);
    expect(result.outcome).toMatchObject({ occupied: true, session: 'resumed' });
    expect(seen[0]).toContain('ses-old');
    child.exit(0);
    await result.settled;
  });

  it('a held seat defers without burning the act (ADR 238)', async () => {
    const { child, backend } = setup();
    const ctx: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'session', lease_matched: false }),
      log: () => {},
    };
    const result = await backend.wake(spec, ctx);
    expect(result.outcome).toMatchObject({ occupied: false, deferred: true });
    child.exit(0);
    await result.settled;
  });
});
