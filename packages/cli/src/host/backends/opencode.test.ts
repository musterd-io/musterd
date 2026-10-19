import { EventEmitter } from 'node:events';
import type { WakeOrder } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { BackendContext, WakeSpec } from '../backend.js';
import {
  buildOpencodeFreshArgs,
  opencodeStandaloneArgs,
  buildOpencodeResumeArgs,
  opencodeBackend,
  opencodeWakeEnv,
  parseOpencodeSessionLine,
  parseOpencodeStepLine,
} from './opencode.js';

class Child extends EventEmitter {
  stdout = new EventEmitter();
  pid: number | undefined;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kill(): boolean {
    return true;
  }
  out(line: string) {
    this.stdout.emit('data', Buffer.from(line + '\n'));
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
};
const spec: WakeSpec = {
  order,
  team: 'dawn',
  server: 'http://s',
  workspace: '/ws',
  bounds: { timeout_ms: 200 },
};
const ctx: BackendContext = {
  // ADR 241: the happy path is a row attesting THIS lease — `lease_matched`.
  verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: true }),
  log: () => {},
};

describe('OpenCode residency argv', () => {
  it('fresh and resume forms carry no workspace flag and never pass a bypass', () => {
    expect(buildOpencodeFreshArgs('line')).toEqual(['run', '--format', 'json', 'line']);
    expect(buildOpencodeResumeArgs('line', 'ses_x')).toEqual([
      'run',
      '--format',
      'json',
      '--session',
      'ses_x',
      'line',
    ]);
    for (const args of [buildOpencodeFreshArgs('line'), buildOpencodeResumeArgs('line', 's')])
      expect(args.join(' ')).not.toMatch(/dangerously|bypass|yolo|auto-approve|approval/i);
  });
  it('accepts only a typed event record with a session id (the run.ts emit shape)', () => {
    expect(
      parseOpencodeSessionLine('{"type":"step_start","timestamp":1,"sessionID":"ses_x"}'),
    ).toBe('ses_x');
    expect(parseOpencodeSessionLine('{"type":"text","timestamp":1}')).toBeUndefined();
    expect(parseOpencodeSessionLine('not json at all')).toBeUndefined();
  });
  it('does not pass ambient musterd credentials into the child', () => {
    const env = opencodeWakeEnv({
      HOME: '/h',
      PATH: '/p',
      MUSTERD_AGENT_KEY: 'secret',
      MUSTERD_GRANT: 'secret',
    });
    expect(env).toMatchObject({ HOME: '/h', PATH: '/p', MUSTERD_PROVENANCE: 'wake' });
    expect(env.MUSTERD_AGENT_KEY).toBeUndefined();
    expect(env.MUSTERD_GRANT).toBeUndefined();
  });

  it('carries the wake lease to the child (ADR 241), and nothing when there is none', () => {
    expect(opencodeWakeEnv({ HOME: '/h' }, 'L42').MUSTERD_WAKE_LEASE).toBe('L42');
    expect(opencodeWakeEnv({ HOME: '/h' }).MUSTERD_WAKE_LEASE).toBeUndefined();
    // ADR 436 clause 3: the harness the host spawned rides beside the lease, stamped at spawn.
    expect(opencodeWakeEnv({ HOME: '/h' }, 'L42').MUSTERD_WAKE_HARNESS).toBe('opencode');
    expect(opencodeWakeEnv({ HOME: '/h' }).MUSTERD_WAKE_HARNESS).toBeUndefined();
  });

  it('puts the pinned actuator build before a Homebrew musterd on PATH', () => {
    expect(
      opencodeWakeEnv(
        { PATH: '/opt/homebrew/bin:/usr/bin', MUSTERD_AGENT_KEY: 'secret' },
        'L42',
        '/Users/nick/.musterd/bin',
      ),
    ).toMatchObject({
      PATH: '/Users/nick/.musterd/bin:/opt/homebrew/bin:/usr/bin',
      MUSTERD_PROVENANCE: 'wake',
      MUSTERD_WAKE_LEASE: 'L42',
    });
  });
});

describe('opencodeBackend', () => {
  it('opencode not found: DEFERS with a named reason, nothing spawned, no attempt spent (ADR 221)', async () => {
    const backend = opencodeBackend({ resolveBin: async () => null });
    const result = await backend.wake(spec, ctx);
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/opencode CLI not found/);
    await result.settled;
  });

  it('requires exact streamed identity and fresh wake Presence before crediting a fresh session', async () => {
    const child = new Child();
    let recorded: string | undefined;
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: (_w, id) => {
        recorded = id;
      },
      spawn: (() => child) as never,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome).toEqual({ occupied: true, session: 'fresh' });
    expect(recorded).toBe('ses_new');
    child.exit();
    await result.settled;
  });

  it('writes the lease naming the child, rewrites it with the streamed session, and reports a take-over (ADR 546)', async () => {
    const child = new Child();
    child.pid = 4242;
    const writes: Array<Record<string, unknown>> = [];
    const clears: string[] = [];
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
      ps: async () => '', // no serve daemon here — the run child's pid is what lands (ADR 613 fallback)
      lease: {
        write: (_ws, lease) => writes.push(lease as unknown as Record<string, unknown>),
        clear: (_ws, id) => clears.push(id),
        takeYield: () => true,
      },
    });
    const wake = backend.wake(spec, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes[0]).toMatchObject({ harness: 'opencode', spawner_pid: 4242 });
    expect(writes[0]).not.toHaveProperty('session_id');
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(writes.at(-1)).toMatchObject({ session_id: 'ses_new' });
    child.exit();
    expect((await result.settled)?.yielded).toBe(true);
    expect(clears).toHaveLength(1);
  });

  it('stamps the lease dream for a dream wake (ADR 604)', async () => {
    const child = new Child();
    child.pid = 4242;
    const writes: Array<Record<string, unknown>> = [];
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
      ps: async () => '',
      lease: {
        write: (_ws, lease) => writes.push(lease as unknown as Record<string, unknown>),
        clear: () => {},
        takeYield: () => false,
      },
    });
    const wake = backend.wake({ ...spec, order: { ...spec.order, derivation: 'dream' } }, ctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(writes[0]).toMatchObject({ provenance: 'dream' });
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    child.exit();
    await result.settled;
  });

  describe('the lease file names the serve daemon the adapter descends from (ADR 613)', () => {
    const uid = typeof process.getuid === 'function' ? process.getuid() : 501;
    // The serve-pid lookup awaits between spawn and the lease write — flush past it.
    const flush = () => new Promise((r) => setTimeout(r, 0));
    const table = (serves: number[]) =>
      [
        `  35892  ${uid}  /usr/local/bin/opencode run --format json`,
        ...serves.map((pid) => `  ${pid}  ${uid}  /usr/local/bin/opencode serve --service`),
        `  79436  0  /usr/local/bin/opencode serve --service`, // another user's — never ours
        `    999  ${uid}  /bin/zsh -l`,
      ].join('\n');
    const backend = (
      child: Child,
      writes: Array<Record<string, unknown>>,
      ps: () => Promise<string>,
    ) =>
      opencodeBackend({
        resolveBin: async () => '/opencode',
        recordFreshSession: () => undefined,
        spawn: (() => child) as never,
        ps,
        lease: {
          write: (_ws, lease) => writes.push(lease as unknown as Record<string, unknown>),
          clear: () => {},
          takeYield: () => false,
        },
      });

    it('one serve daemon owned by this user → spawner_pid is the daemon, not the run child', async () => {
      const child = new Child();
      child.pid = 4242;
      const writes: Array<Record<string, unknown>> = [];
      const wake = backend(child, writes, async () => table([79437])).wake(spec, ctx);
      await flush();
      expect(writes[0]).toMatchObject({ spawner_pid: 79437 });
      child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
      const result = await wake;
      child.exit();
      await result.settled;
    });

    it('no serve daemon → the run child pid (the pre-ADR-613 behavior)', async () => {
      const child = new Child();
      child.pid = 4242;
      const writes: Array<Record<string, unknown>> = [];
      const wake = backend(child, writes, async () => table([])).wake(spec, ctx);
      await flush();
      expect(writes[0]).toMatchObject({ spawner_pid: 4242 });
      child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
      const result = await wake;
      child.exit();
      await result.settled;
    });

    it('several serve daemons → ambiguous, keep the run child pid', async () => {
      const child = new Child();
      child.pid = 4242;
      const writes: Array<Record<string, unknown>> = [];
      const wake = backend(child, writes, async () => table([79437, 79438])).wake(spec, ctx);
      await flush();
      expect(writes[0]).toMatchObject({ spawner_pid: 4242 });
      child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
      const result = await wake;
      child.exit();
      await result.settled;
    });

    it('an unreadable process table → keep the run child pid', async () => {
      const child = new Child();
      child.pid = 4242;
      const writes: Array<Record<string, unknown>> = [];
      const wake = backend(child, writes, async () => {
        throw new Error('ps failed');
      }).wake(spec, ctx);
      await flush();
      expect(writes[0]).toMatchObject({ spawner_pid: 4242 });
      child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
      const result = await wake;
      child.exit();
      await result.settled;
    });
  });

  it('a seat held by a non-wake session DEFERS — it does not burn the act (ADR 238)', async () => {
    const child = new Child();
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
    });
    const heldByOther: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'session', lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, heldByOther);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/session/);
    child.exit();
    await result.settled;
  });

  it('a seat held by ANOTHER WAKE defers too — the lease token decides (ADR 241)', async () => {
    const child = new Child();
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
    });
    const heldByPriorWake: BackendContext = {
      verifyOccupied: async () => ({ occupied: true, provenance: 'wake', lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, heldByPriorWake);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBe(true);
    expect(result.outcome.reason).toMatch(/held by another session/);
    child.exit();
    await result.settled;
  });

  it('a wake that genuinely produced nothing still FAILS — deferral is not the catch-all', async () => {
    const child = new Child();
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      recordFreshSession: () => undefined,
      spawn: (() => child) as never,
    });
    const nobody: BackendContext = {
      verifyOccupied: async () => ({ occupied: false, lease_matched: false }),
      log: () => {},
    };
    const wake = backend.wake(spec, nobody);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    expect(result.outcome.deferred).toBeUndefined();
    child.exit();
    await result.settled;
  });

  it('GUARD: a demoted conflict (slot live) defers without spawning — either side saying live refuses', async () => {
    const spawned: string[][] = [];
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      readSession: () => ({
        state: 'resumable',
        source: 'enumerated',
        slotState: 'live',
        disagreed: true,
        demoted: true,
        session: { harness: 'opencode', id: 'old', started_at: 1 },
      }),
      spawn: ((_bin: string, args: string[]) => {
        spawned.push(args);
        return new Child();
      }) as never,
    });
    const result = await backend.wake(spec, ctx);
    expect(spawned).toHaveLength(0);
    expect(result.outcome).toMatchObject({
      occupied: false,
      deferred: true,
      reason: 'local-session-live',
    });
    await result.settled;
  });

  it('resumes the captured session only when the streamed identity agrees', async () => {
    const child = new Child();
    const calls: string[][] = [];
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      readSession: () => ({
        state: 'resumable',
        session: { harness: 'opencode', id: 'ses_old', started_at: 1 },
      }),
      ensurePinned: () => '/Users/nick/.musterd/bin',
      spawn: ((_bin: string, args: string[]) => {
        calls.push(args);
        return child;
      }) as never,
    });
    const priorPath = process.env.PATH;
    process.env.PATH = '/opt/homebrew/bin:/usr/bin';
    try {
      const wake = backend.wake(spec, ctx);
      await Promise.resolve();
      child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_old"}');
      const result = await wake;
      expect(calls[0]).toEqual(buildOpencodeResumeArgs('wake line', 'ses_old'));
      expect(result.outcome.session).toBe('resumed');
      child.exit();
      await result.settled;
    } finally {
      process.env.PATH = priorPath;
    }
  });

  it('portable fresh orders bypass resume even with a valid local capture', async () => {
    const child = new Child();
    const calls: string[][] = [];
    const lines: string[] = [];
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      readSession: () => ({
        state: 'resumable',
        source: 'slot',
        session: { harness: 'opencode', id: 'ses_old', started_at: 1 },
        transcriptBytes: 4096,
        transcriptMtime: Date.now() - 1_000,
      }),
      recordFreshSession: () => undefined,
      spawn: ((_bin: string, args: string[]) => {
        calls.push(args);
        return child;
      }) as never,
    });
    const wake = backend.wake(
      {
        ...spec,
        order: {
          ...order,
          intended_delivery: 'fresh',
          continuity_requirement: 'portable',
        },
      },
      { ...ctx, log: (line) => lines.push(line) },
    );
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(buildOpencodeFreshArgs('wake line'));
    expect(result.outcome).toMatchObject({
      occupied: true,
      session: 'fresh',
      delivery_outcome: 'fresh',
      transcript_bytes: 4096,
    });
    expect(lines.join('\n')).toMatch(/portable delivery .* fresh spawn \(resume bypassed\)/);
    child.exit();
    await result.settled;
  });

  it('never credits a nonzero child exit, even if a stale roster probe says occupied', async () => {
    const child = new Child();
    const backend = opencodeBackend({
      resolveBin: async () => '/opencode',
      spawn: (() => child) as never,
      recordFreshSession: () => undefined,
    });
    const wake = backend.wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    child.exit(2);
    const result = await wake;
    expect(result.outcome).toMatchObject({ occupied: false, session: 'fresh' });
    expect(result.outcome.reason).toContain('code 2');
    await result.settled;
  });
});

/**
 * The completion record (lane 01M1G310Y7) — same defect and same fix as the codex backend, whose
 * `attempt` this one was written from: `settled` resolved with nothing, so no wake on this
 * harness ever reached the `residency.wake_cost` rail. Wall-clock is host-measured, so every
 * settled run carries it; opencode prints no attested cost, so `cost_usd` stays absent.
 */
describe('the completion record — every settled run reports what the host measured', () => {
  const fresh = (child: Child) =>
    opencodeBackend({
      resolveBin: async () => '/opencode',
      spawn: (() => child) as never,
      recordFreshSession: () => undefined,
    });

  // Verbatim from `opencode run --format json` 1.18.27 on 2026-09-02 (lane 01M1HJY3JF), ids
  // shortened: tokens, and a `cost` opencode computed itself — 0 here.
  const STEP_FINISH =
    '{"type":"step_finish","timestamp":1788396624363,"sessionID":"ses_new","part":{"id":"prt_1",' +
    '"reason":"stop","messageID":"msg_1","sessionID":"ses_new","type":"step-finish",' +
    '"tokens":{"total":10769,"input":10453,"output":11,"reasoning":64,"cache":{"write":0,"read":241}},"cost":0}}';

  it("parses a real step_finish line into usage plus the harness's own price claim", () => {
    expect(parseOpencodeStepLine(STEP_FINISH)).toEqual({
      usage: {
        input_tokens: 10453,
        output_tokens: 11,
        cached_input_tokens: 241,
        cache_write_input_tokens: 0,
        reasoning_output_tokens: 64,
      },
      harness_cost_usd: 0,
    });
    expect(
      parseOpencodeStepLine('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}'),
    ).toBeUndefined();
    expect(parseOpencodeStepLine('{"type":"step_finish","part":{}}')).toBeUndefined();
  });

  it('a settled run carries summed tokens, the harness price as ITS claim, and no cost_usd (ADR 364)', async () => {
    const child = new Child();
    const wake = fresh(child).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    child.out(STEP_FINISH);
    child.out(STEP_FINISH);
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.usage).toEqual({
      input_tokens: 20906,
      output_tokens: 22,
      cached_input_tokens: 482,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 128,
    });
    expect(completion?.harness_cost_usd).toBe(0);
    expect(completion?.unpriced_reason).toBe('harness_price_unverified');
    expect(completion?.cost_usd).toBeUndefined();
  });

  it('a wake whose three local signals agreed at spawn settles as `local` with the snapshot (ADR 663)', async () => {
    const child = new Child();
    const snapshot = {
      provider: 'ollama',
      model: 'qwen3:4b',
      base_url: 'http://127.0.0.1:11434/v1',
    };
    let reads = 0;
    const wake = opencodeBackend({
      resolveBin: async () => '/opencode',
      spawn: (() => child) as never,
      recordFreshSession: () => undefined,
      readLocalServing: () => {
        reads += 1;
        return snapshot;
      },
    }).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    child.out(STEP_FINISH);
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.unpriced_reason).toBe('local');
    expect(completion?.local_serving).toEqual(snapshot);
    expect(completion?.cost_usd).toBeUndefined();
    // Read once, at spawn — not again at settle.
    expect(reads).toBe(1);
  });

  /** ADR 583 note (2026-10-19): a gateway wake runs on a private server that reads the override. */
  it('a metered wake runs --standalone with its hosted providers pointed at the gateway', async () => {
    const child = new Child();
    const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let scans = 0;
    const wake = opencodeBackend({
      resolveBin: async () => '/opencode',
      spawn: ((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
        seen.push({ args, env: opts.env });
        return child;
      }) as never,
      ps: (() => {
        scans += 1;
        return Promise.resolve('');
      }) as never,
      recordFreshSession: () => undefined,
      readLocalServing: () => null,
    }).wake(
      { ...spec, gateway: { env: { OPENAI_BASE_URL: 'x' }, origin: 'http://127.0.0.1:9' } },
      ctx,
    );
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(seen[0]!.args).toEqual(opencodeStandaloneArgs(buildOpencodeFreshArgs('wake line')));
    expect(seen[0]!.args.slice(0, 2)).toEqual(['run', '--standalone']);
    expect(JSON.parse(seen[0]!.env.OPENCODE_CONFIG_CONTENT!)).toEqual({
      provider: {
        opencode: { options: { baseURL: 'http://127.0.0.1:9/opencode' } },
        'opencode-go': { options: { baseURL: 'http://127.0.0.1:9/opencode-go' } },
      },
    });
    expect(seen[0]!.env.OPENAI_BASE_URL).toBe('x');
    // The adapter descends from the standalone run, so the background serve is never looked up.
    expect(scans).toBe(0);
    child.exit(0);
    await result.settled;
  });

  it('a wake with no gateway, or on a local model, keeps the background service and no override', async () => {
    for (const s of [
      spec,
      { ...spec, gateway: { env: {}, origin: 'http://127.0.0.1:9' } },
    ] as WakeSpec[]) {
      const child = new Child();
      const seen: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
      const local = s.gateway !== undefined;
      const wake = opencodeBackend({
        resolveBin: async () => '/opencode',
        spawn: ((_bin: string, args: string[], opts: { env: NodeJS.ProcessEnv }) => {
          seen.push({ args, env: opts.env });
          return child;
        }) as never,
        recordFreshSession: () => undefined,
        readLocalServing: () =>
          local
            ? ({
                provider: 'ollama',
                model: 'qwen3:4b',
                base_url: 'http://127.0.0.1:11434/v1',
              } as never)
            : null,
      }).wake(s, ctx);
      await Promise.resolve();
      child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
      const result = await wake;
      expect(seen[0]!.args).toEqual(buildOpencodeFreshArgs('wake line'));
      expect(seen[0]!.env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
      child.exit(0);
      await result.settled;
    }
  });

  it('without the local snapshot the reason stays harness_price_unverified and carries none', async () => {
    const child = new Child();
    const wake = opencodeBackend({
      resolveBin: async () => '/opencode',
      spawn: (() => child) as never,
      recordFreshSession: () => undefined,
      readLocalServing: () => null,
    }).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.unpriced_reason).toBe('harness_price_unverified');
    expect(completion?.local_serving).toBeUndefined();
  });

  it('a woke run that exits cleanly carries duration_ms', async () => {
    const child = new Child();
    const wake = fresh(child).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    const result = await wake;
    expect(result.outcome.occupied).toBe(true);
    child.exit(0);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
    expect(completion?.cost_usd).toBeUndefined();
  });

  it('a run that FAILS still prices', async () => {
    const child = new Child();
    const wake = fresh(child).wake(spec, ctx);
    await Promise.resolve();
    child.out('{"type":"step_start","timestamp":1,"sessionID":"ses_new"}');
    child.exit(1);
    const result = await wake;
    expect(result.outcome.occupied).toBe(false);
    const completion = await result.settled;
    expect(completion?.duration_ms).toBeTypeOf('number');
  });
});
