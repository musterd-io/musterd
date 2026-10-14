import type { ResidencySteeredBody, WakeLeaseFile, WakeTurnBody } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import type { AgentLoopEngine, EngineRunResult, EngineRunSpec, EngineTurn } from '../engine.js';
import { boundTranscript, nativeBackend, resolveNativeModel, type NativeDeps } from './native.js';

/**
 * The scripted fake-engine suite (ADR 251 Eval): drive the backend through occupy / answer /
 * timeout / deferral (`occupied && !lease_matched`) without a model, a daemon, or a socket.
 * Verification is roster-derived through `ctx.verifyOccupied` stubs — loop internals are never a
 * verification source (ADR 131 §1), and these tests prove the backend honors that.
 */

const binding = {
  server: 'http://127.0.0.1:1',
  team: 'revive',
  surface: 'claude-code',
  agent_key: 'mskey_test',
  model: 'claude-opus-5',
} as never;

function spec(overrides: Partial<WakeSpec['order']> = {}, timeoutMs = 5_000): WakeSpec {
  return {
    order: {
      lease_id: 'L1',
      seat: 'izzo',
      act_id: 'A1',
      act: 'message',
      sender: 'nick',
      lane: 'immediate',
      composed_line: 'You are izzo. Check your inbox.',
      expires_at: Date.now() + 120_000,
      ...overrides,
    } as WakeSpec['order'],
    team: 'revive',
    server: 'http://127.0.0.1:4849',
    workspace: '/tmp/izzo-ws',
    bounds: { timeout_ms: timeoutMs, max_turns: 10 },
  };
}

interface ScriptedEngine extends AgentLoopEngine {
  lastSpec?: EngineRunSpec;
}

/** A fake engine: emits scripted turns, then either resolves or holds until the watchdog aborts. */
function scriptedEngine(script: {
  turns?: Omit<EngineTurn, 'index'>[];
  result?: Partial<EngineRunResult>;
  holdUntilAbort?: boolean;
}): ScriptedEngine {
  const engine: ScriptedEngine = {
    provider: 'scripted',
    async run(runSpec: EngineRunSpec): Promise<EngineRunResult> {
      engine.lastSpec = runSpec;
      const turns = script.turns ?? [];
      turns.forEach((t, i) => runSpec.onTurn?.({ ...t, index: i + 1 }));
      if (script.holdUntilAbort) {
        await new Promise<void>((resolve) => {
          if (runSpec.signal?.aborted) resolve();
          else runSpec.signal?.addEventListener('abort', () => resolve(), { once: true });
        });
        return {
          turns: turns.length,
          end: 'aborted',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          ...script.result,
        };
      }
      return {
        turns: turns.length,
        end: 'completed',
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        cost_usd: 0.01,
        ...script.result,
      };
    },
  };
  return engine;
}

const turn = (cost: number): Omit<EngineTurn, 'index'> => ({
  usage: {
    input_tokens: 100,
    output_tokens: 10,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  },
  cost_usd: cost,
  stop_reason: 'tool_use',
  transcript: { assistant: [{ type: 'text', text: 'working' }], tool_results: null },
});

function makeDeps(overrides: Partial<NativeDeps> = {}): {
  deps: NativeDeps;
  posted: WakeTurnBody[];
  steered: ResidencySteeredBody[];
  closed: { count: number };
  leases: { written: WakeLeaseFile[]; cleared: string[] };
  spooled: { turns: unknown[]; ends: boolean[] };
} {
  const posted: WakeTurnBody[] = [];
  const steered: ResidencySteeredBody[] = [];
  const closed = { count: 0 };
  const leases = { written: [] as WakeLeaseFile[], cleared: [] as string[] };
  const spooled = { turns: [] as unknown[], ends: [] as boolean[] };
  const deps: NativeDeps = {
    engine: scriptedEngine({}),
    readBinding: () => binding,
    readSession: () => ({ state: 'none', source: 'slot' }) as never,
    openBridge: async () => ({
      tools: [],
      onRaised: () => () => undefined,
      close: async () => {
        closed.count += 1;
      },
    }),
    telemetry: () => ({
      wakeTurn: async (_team: string, body: WakeTurnBody) => {
        posted.push(body);
        return { ok: true, turn: body.turn };
      },
      wakeTranscript: async () => ({ seat: 'izzo', leases: [], omitted_leases: 0 }),
      residencySteered: async (_t: string, body: ResidencySteeredBody) => {
        steered.push(body);
        return { ok: true };
      },
    }),
    env: {},
    finalReadDelayMs: 0,
    // No test touches the disk: the lease file, the watch spool and the yield marker are all stubs.
    lease: {
      write: (_ws, lease) => leases.written.push(lease),
      clear: (_ws, id) => leases.cleared.push(id),
      takeYield: () => false,
    },
    openSpool: () => ({
      turn: (content) => void spooled.turns.push(content),
      end: (clean) => void spooled.ends.push(clean),
    }),
    yieldRequested: () => false,
    yieldPollMs: 5,
    ...overrides,
  };
  return { deps, posted, steered, closed, leases, spooled };
}

function ctx(verify: BackendContext['verifyOccupied'], log: string[] = []): BackendContext {
  return {
    verifyOccupied: verify,
    log: (line: string) => log.push(line),
  };
}

const never = () => new Promise<never>(() => undefined);

describe('resolveNativeModel (ADR 101 env > binding, never a default)', () => {
  it('env wins, binding is the fallback, nothing yields undefined', () => {
    expect(resolveNativeModel({ MUSTERD_MODEL: 'claude-sonnet-5' }, binding)).toEqual({
      model: 'claude-sonnet-5',
      source: 'environment',
    });
    expect(resolveNativeModel({}, binding)).toEqual({ model: 'claude-opus-5', source: 'binding' });
    expect(
      resolveNativeModel({}, { ...(binding as object), model: undefined } as never).model,
    ).toBeUndefined();
  });
});

describe('boundTranscript', () => {
  it('passes a small transcript through and replaces an oversized one with a marker', () => {
    const small = { assistant: [{ type: 'text', text: 'hi' }] };
    expect(boundTranscript(small)).toEqual(small);
    const big = boundTranscript({ blob: 'x'.repeat(300_000) }) as {
      truncated: boolean;
      bytes: number;
    };
    expect(big.truncated).toBe(true);
    expect(big.bytes).toBeGreaterThan(262_144);
  });
});

describe('nativeBackend.wake', () => {
  it('occupy + answer: verified from the roster with the lease token, per-turn rows posted, bridge closed', async () => {
    const engine = scriptedEngine({
      turns: [turn(0.005), turn(0.007)],
      result: { end: 'completed', cost_usd: 0.012 },
    });
    const { deps, posted, closed } = makeDeps({ engine });
    const log: string[] = [];
    const backend = nativeBackend(deps);
    const actuation = await backend.wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }), log),
    );
    expect(actuation.outcome).toMatchObject({ occupied: true, session: 'fresh' });
    const completion = await actuation.settled;
    expect(completion?.cost_usd).toBeCloseTo(0.012, 9);
    expect(completion?.duration_ms).toBeGreaterThanOrEqual(0);
    expect(closed.count).toBe(1);
    expect(posted.map((p) => p.turn)).toEqual([1, 2]);
    expect(posted[0]).toMatchObject({ lease_id: 'L1', cost_usd: 0.005, stop_reason: 'tool_use' });
    expect(posted[0]!.transcript).toMatchObject({ assistant: [{ type: 'text' }] });
    expect(log.some((l) => l.includes('woke izzo'))).toBe(true);
    // The engine got the daemon-composed line verbatim and the ladder-resolved model.
    expect(engine.lastSpec?.prompt).toBe('You are izzo. Check your inbox.');
    expect(engine.lastSpec?.model).toBe('claude-opus-5');
    expect(engine.lastSpec?.maxTurns).toBe(10);
  });

  it('defers when the seat is held by another session (occupied && !lease_matched, ADR 241) and aborts the loop', async () => {
    const engine = scriptedEngine({ holdUntilAbort: true });
    const { deps } = makeDeps({ engine });
    const actuation = await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'session', lease_matched: false })),
    );
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBe(true);
    expect(actuation.outcome.reason).toContain('held by another session');
    await actuation.settled;
    expect(engine.lastSpec?.signal?.aborted).toBe(true);
  });

  it('fails the wake when nobody occupies within the verify window, aborting the loop', async () => {
    const engine = scriptedEngine({ holdUntilAbort: true });
    const { deps, closed } = makeDeps({ engine });
    const actuation = await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: false, lease_matched: false })),
    );
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.deferred).toBeUndefined();
    expect(actuation.outcome.reason).toContain('no roster occupancy');
    // Fast-fail merge: the loop already ended, so the primary report carries duration.
    expect(actuation.outcome.duration_ms).toBeGreaterThanOrEqual(0);
    await actuation.settled;
    expect(closed.count).toBe(1);
  });

  it('watchdog: a tiny timeout aborts the loop and names itself in the failure reason', async () => {
    const engine = scriptedEngine({ holdUntilAbort: true });
    const { deps } = makeDeps({ engine });
    // Verification outlasts the 50ms watchdog, so the watchdog is what kills the loop.
    const slowVerify = () =>
      new Promise<{ occupied: boolean; lease_matched: boolean }>((r) =>
        setTimeout(() => r({ occupied: false, lease_matched: false }), 500),
      );
    const actuation = await nativeBackend(deps).wake(spec({}, 50), ctx(slowVerify));
    expect(actuation.outcome.occupied).toBe(false);
    expect(actuation.outcome.reason).toContain('watchdog timeout (50ms)');
    await actuation.settled;
  });

  it('defers on missing credentials (auth end) — a machine property, never a charged failure', async () => {
    const engine = scriptedEngine({
      result: { end: 'auth', reason: 'invalid x-api-key', turns: 0 },
    });
    const { deps } = makeDeps({ engine });
    const actuation = await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: false, lease_matched: false })),
    );
    expect(actuation.outcome).toMatchObject({ occupied: false, deferred: true });
    expect(actuation.outcome.reason).toContain('credentials');
  });

  it('defers when the workspace has no binding, and when no model is declared (ADR 101)', async () => {
    const noBinding = makeDeps({ readBinding: () => null });
    const a1 = await nativeBackend(noBinding.deps).wake(spec(), ctx(never));
    expect(a1.outcome).toMatchObject({ occupied: false, deferred: true });

    const noModel = makeDeps({
      readBinding: () => ({ ...(binding as object), model: undefined }) as never,
    });
    const a2 = await nativeBackend(noModel.deps).wake(spec(), ctx(never));
    expect(a2.outcome).toMatchObject({ occupied: false, deferred: true });
    expect(a2.outcome.reason).toContain('model');
  });

  it('defers when a live local session holds the workspace', async () => {
    const { deps } = makeDeps({ readSession: () => ({ state: 'live', source: 'slot' }) as never });
    const actuation = await nativeBackend(deps).wake(spec(), ctx(never));
    expect(actuation.outcome).toMatchObject({
      occupied: false,
      deferred: true,
      reason: 'local-session-live',
    });
  });

  it('resolves the model from the env over the binding (ADR 101 ladder)', async () => {
    const engine = scriptedEngine({});
    const { deps } = makeDeps({ engine, env: { MUSTERD_MODEL: 'claude-sonnet-5' } });
    await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(engine.lastSpec?.model).toBe('claude-sonnet-5');
  });

  it('tolerates a failing telemetry rail — capture is best-effort, the wake still succeeds', async () => {
    const engine = scriptedEngine({ turns: [turn(0.005)] });
    const { deps } = makeDeps({
      engine,
      telemetry: () => ({
        wakeTurn: async () => {
          throw new Error('daemon unreachable');
        },
        wakeTranscript: async () => {
          throw new Error('daemon unreachable');
        },
        residencySteered: async () => {
          throw new Error('daemon unreachable');
        },
      }),
    });
    const actuation = await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(actuation.outcome.occupied).toBe(true);
    await actuation.settled;
  });

  it('ADR 588: a seat-policy wake carries the four jailed working tools; a reply wake does not', async () => {
    const working = scriptedEngine({});
    const { deps } = makeDeps({ engine: working });
    await nativeBackend(deps).wake(
      spec({ tool_policy: 'seat-policy' } as never),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(working.lastSpec?.tools.map((t) => t.name)).toEqual(['read', 'write', 'edit', 'bash']);
    const reply = scriptedEngine({});
    const { deps: replyDeps } = makeDeps({ engine: reply });
    await nativeBackend(replyDeps).wake(
      spec({ tool_policy: 'reply-only' } as never),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(reply.lastSpec?.tools).toEqual([]);
  });

  it('ADR 395: the capture rail rides the host-scoped key when the binding has one, else agent_key', async () => {
    const seen: string[] = [];
    const { deps } = makeDeps({
      readBinding: () => ({ ...(binding as object), host_key: 'mskey_host' }) as never,
      telemetry: (_server: string, key: string) => {
        seen.push(key);
        return {
          wakeTurn: async (_t: string, body: WakeTurnBody) => ({ ok: true, turn: body.turn }),
          wakeTranscript: async () => ({ seat: 'izzo', leases: [], omitted_leases: 0 }),
          residencySteered: async () => ({ ok: true }),
        };
      },
    });
    await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(seen).toEqual(['mskey_host']);
    const { deps: legacy } = makeDeps({
      telemetry: (_server: string, key: string) => {
        seen.push(key);
        return {
          wakeTurn: async (_t: string, body: WakeTurnBody) => ({ ok: true, turn: body.turn }),
          wakeTranscript: async () => ({ seat: 'izzo', leases: [], omitted_leases: 0 }),
          residencySteered: async () => ({ ok: true }),
        };
      },
    });
    await nativeBackend(legacy).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(seen).toEqual(['mskey_host', 'mskey_test']);
  });

  it('ADR 588 §6: a raised act reaches the engine through the run spec’s steer source and posts a residency.steered receipt', async () => {
    let raised: ((line: string, actId: string) => void) | undefined;
    const engine = scriptedEngine({});
    const { deps, steered } = makeDeps({
      engine,
      openBridge: async () => ({
        tools: [],
        onRaised: (deliver) => {
          raised = deliver;
          return () => undefined;
        },
        close: async () => undefined,
      }),
    });
    const log: string[] = [];
    await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }), log),
    );
    const heard: string[] = [];
    const unsubscribe = engine.lastSpec?.steer?.subscribe((line) => heard.push(line));
    expect(raised).toBeDefined();
    raised!('⚡ musterd [revive]: steer from nick (steer) — read exactly it', 'ACT1');
    await new Promise((r) => setTimeout(r, 5));
    expect(heard).toEqual(['⚡ musterd [revive]: steer from nick (steer) — read exactly it']);
    expect(steered).toEqual([
      expect.objectContaining({ lease_id: 'L1', act_id: 'ACT1', delivered_at: expect.any(Number) }),
    ]);
    expect(log.some((l) => l.includes('steered izzo: act ACT1'))).toBe(true);
    unsubscribe?.();
  });

  it('ADR 588: a key_env that is unset on this host defers the wake, naming the variable, never a value', async () => {
    const engine = scriptedEngine({});
    const { deps } = makeDeps({ engine, env: { OTHER: 'x' } });
    const actuation = await nativeBackend(deps).wake(
      { ...spec(), key_env: 'SEAT_KEY' },
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true })),
    );
    expect(actuation.outcome).toMatchObject({ occupied: false, deferred: true });
    expect(actuation.outcome.reason).toContain('SEAT_KEY');
    expect(engine.lastSpec).toBeUndefined();
  });

  it('ADR 588: the rehydration read is best-effort and its tally is one narrator line', async () => {
    const log: string[] = [];
    const { deps } = makeDeps({
      telemetry: () => ({
        wakeTurn: async (_t: string, body: WakeTurnBody) => ({ ok: true, turn: body.turn }),
        residencySteered: async () => ({ ok: true }),
        wakeTranscript: async () => ({
          seat: 'izzo',
          leases: [
            {
              lease_id: 'L0',
              created_at: 1,
              turns: [
                {
                  turn: 1,
                  usage: { input_tokens: 1, output_tokens: 1 },
                  cost_usd: null,
                  stop_reason: null,
                  transcript: null,
                  created_at: 2,
                },
              ],
            },
          ],
          omitted_leases: 2,
        }),
      }),
    });
    await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'wake', lease_matched: true }), log),
    );
    expect(log.find((l) => l.includes('rehydrate'))).toMatch(
      /1 earlier wake\(s\), 1 turn\(s\), 2 older omitted/,
    );
  });

  it('flags an occupancy that attests a provenance other than wake', async () => {
    const log: string[] = [];
    const { deps } = makeDeps();
    await nativeBackend(deps).wake(
      spec(),
      ctx(async () => ({ occupied: true, provenance: 'session', lease_matched: true }), log),
    );
    expect(log.some((l) => l.includes('provenance'))).toBe(true);
  });
});

describe('nativeBackend.wake — take-over and watch (ADR 546, lane 6/6)', () => {
  const verified = async () => ({ occupied: true, provenance: 'wake', lease_matched: true });

  it('holds an in-process lease with the host pid, and clears it when the run settles', async () => {
    const { deps, leases, spooled } = makeDeps({
      engine: scriptedEngine({ turns: [turn(0.005)] }),
    });
    const actuation = await nativeBackend(deps).wake(spec(), ctx(verified));
    expect(leases.written).toEqual([
      expect.objectContaining({
        lease_id: 'L1',
        harness: 'musterd',
        spawner_pid: process.pid,
        in_process: true,
      }),
    ]);
    expect(leases.written[0]!.session_id).toBeUndefined();
    await actuation.settled;
    expect(leases.cleared).toEqual(['L1']);
    // The watch spool got the turn's assistant content and a clean end.
    expect(spooled.turns).toEqual([[{ type: 'text', text: 'working' }]]);
    expect(spooled.ends).toEqual([true]);
  });

  it('a run cut short is spooled as not clean', async () => {
    const { deps, spooled } = makeDeps({
      engine: scriptedEngine({ result: { end: 'max_turns' } }),
    });
    await (
      await nativeBackend(deps).wake(spec(), ctx(verified))
    ).settled;
    expect(spooled.ends).toEqual([false]);
  });

  it('a yield marker ends an idle loop and the completion says it was taken over', async () => {
    let marker = false;
    const { deps } = makeDeps({
      engine: scriptedEngine({ holdUntilAbort: true }),
      yieldRequested: () => marker,
      lease: { write: () => undefined, clear: () => undefined, takeYield: () => marker },
    });
    const actuation = await nativeBackend(deps).wake(spec(), ctx(verified));
    marker = true;
    const completion = await actuation.settled;
    expect(completion?.yielded).toBe(true);
  });

  it('waits for a running tool to return before it stops the loop', async () => {
    let marker = false;
    let finishTool!: (v: string) => void;
    let aborted = false;
    const engine: AgentLoopEngine = {
      provider: 'scripted',
      async run(runSpec) {
        runSpec.signal?.addEventListener('abort', () => (aborted = true), { once: true });
        await runSpec.tools[0]!.run({});
        await new Promise<void>((r) => setTimeout(r, 30));
        return {
          turns: 1,
          end: aborted ? 'aborted' : 'completed',
          usage: {
            input_tokens: 0,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        };
      },
    };
    const { deps } = makeDeps({
      engine,
      openBridge: async () => ({
        tools: [
          {
            name: 'team_send',
            description: '',
            input_schema: { type: 'object' },
            run: () => new Promise<string>((r) => (finishTool = r)),
          },
        ],
        onRaised: () => () => undefined,
        close: async () => undefined,
      }),
      yieldRequested: () => marker,
    });
    const actuation = await nativeBackend(deps).wake(spec(), ctx(verified));
    marker = true;
    await new Promise<void>((r) => setTimeout(r, 40)); // several polls pass with the tool running
    expect(aborted).toBe(false);
    finishTool('sent');
    await actuation.settled;
    expect(aborted).toBe(true);
  });

  it('a marker for another lease stops nothing', async () => {
    const { deps } = makeDeps({
      engine: scriptedEngine({ turns: [turn(0.005)] }),
      yieldRequested: (_ws, lease) => lease === 'OTHER',
    });
    const completion = await (await nativeBackend(deps).wake(spec(), ctx(verified))).settled;
    expect(completion?.yielded).toBeUndefined();
  });
});
