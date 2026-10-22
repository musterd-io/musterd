import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { declineSurface } from '../declined.js';
import { buildEntry } from '../mcpEntry.js';
import {
  GATE_MARKER,
  GROK_INTERRUPT_PRE_WRAP,
  GROK_INTERRUPT_STOP_SCRIPT,
  INTERRUPT_MARKER,
  STOP_MARKER,
  grok,
  grokInterruptPreCommand,
  grokInterruptStopCommand,
  inspectGrokHookDrift,
} from './grok.js';

const binding = {
  server: 'http://localhost:4849',
  team: 'dawn',
  agent_key: 'mskey_secret',
  surface: 'grok' as const,
  claim: { mode: 'seat' as const, name: 'Ada' },
};

type HookFile = {
  hooks: Record<
    string,
    { matcher?: string; hooks: { type: string; command: string; timeout?: number }[] }[]
  >;
};

let cwd: string;
let origCwd: string;
const hooksPath = () => join(cwd, '.grok', 'hooks', 'musterd.json');
const globalInterruptPath = () =>
  join(process.env['MUSTERD_GROK_HOOKS_HOME']!, 'musterd-interrupt.json');

function readHooks(): HookFile {
  return JSON.parse(readFileSync(hooksPath(), 'utf8')) as HookFile;
}

function readGlobal(): HookFile {
  return JSON.parse(readFileSync(globalInterruptPath(), 'utf8')) as HookFile;
}

function commandsOn(event: string): string[] {
  return (readHooks().hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

function globalCommands(event: string): string[] {
  return (readGlobal().hooks[event] ?? []).flatMap((g) => g.hooks.map((h) => h.command));
}

beforeEach(() => {
  origCwd = process.cwd();
  cwd = mkdtempSync(join(tmpdir(), 'musterd-grok-hooks-'));
  process.env['MUSTERD_GROK_HOOKS_HOME'] = join(cwd, 'grok-user-hooks');
  process.chdir(cwd);
  cwd = process.cwd();
});
afterEach(() => {
  process.chdir(origCwd);
  delete process.env['MUSTERD_GROK_HOOKS_HOME'];
  rmSync(cwd, { recursive: true, force: true });
});

describe('grok interrupt injection (ADR 370)', () => {
  it('wraps interrupt-check as PreToolUse additionalContext, not discarded PostToolUse stdout', async () => {
    await grok.configure(buildEntry(binding), binding);
    expect(existsSync(hooksPath())).toBe(true);
    expect(existsSync(globalInterruptPath())).toBe(true);

    const pre = readHooks().hooks['PreToolUse'] ?? [];
    expect(pre.some((g) => g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)))).toBe(false);
    const gate = pre.find((g) => g.hooks.some((h) => h.command.includes(GATE_MARKER)));
    expect(gate).toBeDefined();
    expect(gate?.matcher).toContain('run_terminal_command');

    const interrupt = (readGlobal().hooks['PreToolUse'] ?? []).find((g) =>
      g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)),
    );
    expect(interrupt).toBeDefined();
    expect(interrupt?.matcher).toBeUndefined();
    const cmd = interrupt!.hooks[0]!.command;
    expect(cmd).toContain('inbox --interrupt-check');
    expect(cmd).toContain('additionalContext');
    expect(cmd).toContain('PreToolUse');
    expect(cmd).toContain('musterd:start');
    expect(cmd).toContain('grok:PreToolUse');
    expect(cmd).not.toContain('interrupt-check >/dev/null');

    expect(commandsOn('PostToolUse').some((c) => c.includes(INTERRUPT_MARKER))).toBe(false);
  });

  it('installs a Stop hook that blocks end_turn once with the interrupt line', async () => {
    await grok.configure(buildEntry(binding), binding);
    expect(readHooks().hooks['Stop']).toBeUndefined();
    const stop = readGlobal().hooks['Stop'] ?? [];
    expect(stop).toHaveLength(1);
    const cmd = stop[0]!.hooks[0]!.command;
    expect(cmd).toContain(STOP_MARKER);
    expect(cmd).toContain('--interrupt-check');
    expect(cmd).toContain('end_turn');
    expect(cmd).toContain('stopHookActive');
    expect(cmd).toContain('decision:"block"');
    expect(cmd).toContain('musterd:start');
    expect(cmd).toContain('grok:Stop');
    expect(cmd).not.toContain('interrupt-check >/dev/null');
    expect(stop[0]!.hooks[0]!.timeout).toBe(10);
  });

  it('reports drift when the PreToolUse interrupt or Stop hook is missing', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readGlobal();
    delete file.hooks['PreToolUse'];
    delete file.hooks['Stop'];
    writeFileSync(globalInterruptPath(), JSON.stringify(file));
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('PreToolUse interrupt'))).toBe(true);
    expect(drift.some((d) => d.includes('musterd-interrupt.json'))).toBe(true);
    expect(drift.some((d) => d.includes('Stop'))).toBe(true);
  });

  it('drops a leftover PostToolUse interrupt hook on refresh (ADR 370 move)', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readHooks();
    file.hooks['PostToolUse'] = [
      {
        hooks: [
          {
            type: 'command',
            command: `command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check >/dev/null 2>&1 || true # ${INTERRUPT_MARKER}`,
          },
        ],
      },
    ];
    writeFileSync(hooksPath(), `${JSON.stringify(file, null, 2)}\n`);
    grok.refreshHooks!.run(cwd);
    expect(commandsOn('PostToolUse').some((c) => c.includes(INTERRUPT_MARKER))).toBe(false);
  });

  it('reports drift while a leftover PostToolUse interrupt hook is still installed', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readHooks();
    file.hooks['PostToolUse'] = [
      {
        hooks: [
          {
            type: 'command',
            command: `command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check >/dev/null 2>&1 || true # ${INTERRUPT_MARKER}`,
          },
        ],
      },
    ];
    writeFileSync(hooksPath(), JSON.stringify(file));
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('leftover') && d.includes('PostToolUse'))).toBe(true);
  });

  it('a same-marker PreToolUse that discards stdout is STALE, not healthy (clause 4)', async () => {
    // The contract's grok row: inspectGrokHookDrift named missing markers and a leftover
    // PostToolUse; a stale PreToolUse that still carries musterd-grok-interrupt but discards
    // stdout passed. Presence was never the question (ADR 168). The hook now lives in the
    // global file (ADR 718).
    await grok.configure(buildEntry(binding), binding);
    const file = readGlobal();
    const groups = file.hooks['PreToolUse'] ?? [];
    const interrupt = groups.find((g) => g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)));
    expect(interrupt).toBeDefined();
    interrupt!.hooks[0]!.command = `command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check >/dev/null 2>&1 || true # ${INTERRUPT_MARKER}`;
    writeFileSync(globalInterruptPath(), JSON.stringify(file));
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('STALE') && d.includes(INTERRUPT_MARKER))).toBe(true);
    expect(drift.some((d) => d.includes('musterd-interrupt.json'))).toBe(true);
    expect(drift.some((d) => d.includes('musterd init --refresh-hooks'))).toBe(true);
    expect(drift.some((d) => d.includes('PreToolUse interrupt is missing'))).toBe(false);
  });

  it('a freshly installed fleet reports ZERO command-text drift', async () => {
    await grok.configure(buildEntry(binding), binding);
    expect(inspectGrokHookDrift(cwd).filter((d) => d.includes('STALE'))).toEqual([]);
    grok.refreshHooks!.run(cwd);
    expect(inspectGrokHookDrift(cwd).filter((d) => d.includes('STALE'))).toEqual([]);
  });

  it('a NEWER-epoch hook blames the checkout and forbids init', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readGlobal();
    const groups = file.hooks['PreToolUse'] ?? [];
    const interrupt = groups.find((g) => g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)));
    interrupt!.hooks[0]!.command =
      `command -v musterd >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && ` +
      `musterd inbox --interrupt-check 2>/dev/null | node -e 'void 0' || true # ${INTERRUPT_MARKER} e999`;
    writeFileSync(globalInterruptPath(), JSON.stringify(file));
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('this checkout is behind'))).toBe(true);
    expect(drift.some((d) => d.includes('musterd-interrupt.json'))).toBe(true);
    expect(drift.some((d) => d.includes('do NOT run'))).toBe(true);
    expect(drift.some((d) => d.includes('present but STALE'))).toBe(false);
  });

  it('a declined event still reports a STALE hook (ADR 332: tombstone is not a licence to leave a wrong one)', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readGlobal();
    const groups = file.hooks['PreToolUse'] ?? [];
    const interrupt = groups.find((g) => g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)));
    interrupt!.hooks[0]!.command = `command -v musterd >/dev/null 2>&1 && musterd inbox --interrupt-check >/dev/null 2>&1 || true # ${INTERRUPT_MARKER}`;
    writeFileSync(globalInterruptPath(), JSON.stringify(file));
    declineSurface(cwd, 'grok:PreToolUse');
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('STALE') && d.includes(INTERRUPT_MARKER))).toBe(true);
  });

  it('a decline does not delete the machine-wide interrupt, and a missing one is still drift', async () => {
    await grok.configure(buildEntry(binding), binding);
    declineSurface(cwd, 'grok:PreToolUse');
    declineSurface(cwd, 'grok:Stop');
    grok.refreshHooks!.run(cwd);
    expect(globalCommands('PreToolUse').some((c) => c.includes(INTERRUPT_MARKER))).toBe(true);
    expect(globalCommands('Stop').some((c) => c.includes(STOP_MARKER))).toBe(true);
    rmSync(globalInterruptPath());
    const drift = inspectGrokHookDrift(cwd);
    expect(drift.some((d) => d.includes('PreToolUse interrupt'))).toBe(true);
    expect(drift.some((d) => d.includes('Stop interrupt'))).toBe(true);
  });

  it('drops a leftover project-file interrupt so the global hook is the only copy', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readHooks();
    file.hooks['PreToolUse'] = [
      ...(file.hooks['PreToolUse'] ?? []),
      { hooks: [{ type: 'command', command: grokInterruptPreCommand() }] },
    ];
    file.hooks['Stop'] = [{ hooks: [{ type: 'command', command: grokInterruptStopCommand() }] }];
    writeFileSync(hooksPath(), `${JSON.stringify(file, null, 2)}\n`);
    const before = inspectGrokHookDrift(cwd);
    expect(before.some((d) => d.includes('leftover') && d.includes('PreToolUse'))).toBe(true);
    expect(before.some((d) => d.includes('leftover') && d.includes('Stop'))).toBe(true);
    grok.refreshHooks!.run(cwd);
    expect(commandsOn('PreToolUse').some((c) => c.includes(INTERRUPT_MARKER))).toBe(false);
    expect(commandsOn('Stop').some((c) => c.includes(STOP_MARKER))).toBe(false);
    expect(globalCommands('PreToolUse').some((c) => c.includes(INTERRUPT_MARKER))).toBe(true);
  });

  it('refresh refuses to downgrade a newer-epoch hook and names the marker', async () => {
    await grok.configure(buildEntry(binding), binding);
    const file = readGlobal();
    const groups = file.hooks['PreToolUse'] ?? [];
    const interrupt = groups.find((g) => g.hooks.some((h) => h.command.includes(INTERRUPT_MARKER)));
    const future =
      `command -v musterd >/dev/null 2>&1 && command -v node >/dev/null 2>&1 && ` +
      `musterd inbox --interrupt-check 2>/dev/null | node -e 'void 0' || true # ${INTERRUPT_MARKER} e999`;
    interrupt!.hooks[0]!.command = future;
    writeFileSync(globalInterruptPath(), `${JSON.stringify(file, null, 2)}\n`);
    const result = grok.refreshHooks!.run(cwd);
    expect(globalCommands('PreToolUse').find((c) => c.includes(INTERRUPT_MARKER))).toBe(future);
    expect(result.warnings.some((w) => w.includes('refused') && w.includes(INTERRUPT_MARKER))).toBe(
      true,
    );
  });
});

function runNode(script: string, stdin: string, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ['-e', script], {
    input: stdin,
    encoding: 'utf8',
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function fakeMusterd(dir: string, stdout: string): string {
  const bin = join(dir, 'musterd');
  writeFileSync(bin, `#!/bin/sh\nprintf '%s' ${JSON.stringify(stdout)}\n`);
  chmodSync(bin, 0o755);
  return dir;
}

describe('grok interrupt scripts (ADR 370)', () => {
  it('wraps a non-empty interrupt line as PreToolUse additionalContext and stays silent when empty', () => {
    const hit = runNode(GROK_INTERRUPT_PRE_WRAP, 'urgent from nick\n');
    expect(hit.status).toBe(0);
    expect(JSON.parse(hit.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        additionalContext: 'urgent from nick',
      },
    });
    const miss = runNode(GROK_INTERRUPT_PRE_WRAP, '  \n');
    expect(miss.status).toBe(0);
    expect(miss.stdout).toBe('');
  });

  it('Stop blocks a genuine end_turn once, and ignores shutdown / already-continued', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'musterd-fake-'));
    try {
      const env = {
        PATH: `${fakeMusterd(binDir, 'urgent from nick')}:${process.env['PATH'] ?? ''}`,
      };
      const block = runNode(
        GROK_INTERRUPT_STOP_SCRIPT,
        JSON.stringify({ reason: 'end_turn' }),
        env,
      );
      expect(block.status).toBe(0);
      expect(JSON.parse(block.stdout)).toEqual({ decision: 'block', reason: 'urgent from nick' });

      const continued = runNode(
        GROK_INTERRUPT_STOP_SCRIPT,
        JSON.stringify({ reason: 'end_turn', stopHookActive: true }),
        env,
      );
      expect(continued.status).toBe(0);
      expect(continued.stdout).toBe('');

      const shutdown = runNode(
        GROK_INTERRUPT_STOP_SCRIPT,
        JSON.stringify({ reason: 'shutdown' }),
        env,
      );
      expect(shutdown.status).toBe(0);
      expect(shutdown.stdout).toBe('');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  // Lane 01M3MTYP9D: a probe that exits without draining stdin leaves the script's write of the
  // payload with EPIPE. `execFileSync` raised that as a throw and the block was lost — ~3% of runs
  // with the non-reading fake above, the `grok.hooks` CI flake. A payload larger than the pipe
  // buffer makes the write block until the child reads, so a fake that never reads forces EPIPE
  // deterministically; the verdict must still come from the child's stdout.
  it('Stop still blocks when the probe exits without reading its stdin (EPIPE)', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'musterd-fake-'));
    try {
      const env = {
        PATH: `${fakeMusterd(binDir, 'urgent from nick')}:${process.env['PATH'] ?? ''}`,
      };
      const block = runNode(
        GROK_INTERRUPT_STOP_SCRIPT,
        JSON.stringify({ reason: 'end_turn', pad: 'x'.repeat(1 << 20) }),
        env,
      );
      expect(block.status).toBe(0);
      expect(JSON.parse(block.stdout)).toEqual({ decision: 'block', reason: 'urgent from nick' });
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  // ADR 445 (lane 01M3MG7EAM): the probe can only tap a payload it is handed, and only when its
  // hook line names the harness. The Stop script used to spawn the probe with stdin ignored.
  it('Stop hands its payload to the probe and names the harness', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'musterd-fake-'));
    try {
      const log = join(binDir, 'seen');
      const bin = join(binDir, 'musterd');
      writeFileSync(
        bin,
        `#!/bin/sh\necho "$@" > ${JSON.stringify(log)}\ncat >> ${JSON.stringify(log)}\n`,
      );
      chmodSync(bin, 0o755);
      const payload = JSON.stringify({
        reason: 'end_turn',
        sessionId: 'g1',
        hookEventName: 'Stop',
      });
      const run = runNode(GROK_INTERRUPT_STOP_SCRIPT, payload, {
        PATH: `${binDir}:${process.env['PATH'] ?? ''}`,
      });
      expect(run.status).toBe(0);
      const [args, ...stdin] = readFileSync(log, 'utf8').split('\n');
      expect(args).toBe('inbox --interrupt-check --hook grok');
      expect(stdin.join('\n').trim()).toBe(payload);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it('the PreToolUse probe names the harness, so its piped payload is tapped', () => {
    expect(grokInterruptPreCommand()).toContain('musterd inbox --interrupt-check --hook grok ');
  });

  it('Stop stays silent when interrupt-check prints nothing', () => {
    const binDir = mkdtempSync(join(tmpdir(), 'musterd-fake-'));
    try {
      const env = { PATH: `${fakeMusterd(binDir, '')}:${process.env['PATH'] ?? ''}` };
      const idle = runNode(GROK_INTERRUPT_STOP_SCRIPT, JSON.stringify({ reason: 'end_turn' }), env);
      expect(idle.status).toBe(0);
      expect(idle.stdout).toBe('');
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });
});
