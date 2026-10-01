import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { supervise } from './supervise.js';

const plan = (args: string[]) => ({
  bin: process.execPath,
  args,
  cwd: process.cwd(),
  harness: 'claude-code',
});

describe('supervise (ADR 491 Decision 3)', () => {
  it('returns the harness exit code', async () => {
    const r = await supervise(plan(['-e', 'process.exit(3)']), { env: process.env });
    expect(r.code).toBe(3);
  });

  it('a harness killed by a signal exits 128 + n', async () => {
    const r = await supervise(plan(['-e', "process.kill(process.pid, 'SIGTERM')"]));
    expect(r.code).toBe(143);
  });

  it('a binary that cannot start is a CliError', async () => {
    await expect(
      supervise({
        bin: '/nonexistent/claude',
        args: [],
        cwd: process.cwd(),
        harness: 'claude-code',
      }),
    ).rejects.toThrow(/couldn't start \/nonexistent\/claude/);
  });

  it('ignores SIGINT/SIGQUIT, forwards SIGTERM/SIGHUP, and unregisters on exit', async () => {
    const child = Object.assign(new EventEmitter(), { kill: vi.fn(() => true) });
    const handlers = new Map<string, () => void>();
    const signals = {
      on: (sig: string, fn: () => void) => void handlers.set(sig, fn),
      off: (sig: string) => void handlers.delete(sig),
    };
    let t = 1_000;
    const done = supervise(plan([]), {
      spawn: (() => child) as never,
      signals: signals as never,
      now: () => (t += 500),
    });
    handlers.get('SIGINT')!();
    handlers.get('SIGQUIT')!();
    expect(child.kill).not.toHaveBeenCalled();
    handlers.get('SIGTERM')!();
    handlers.get('SIGHUP')!();
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGHUP']]);
    child.emit('exit', 0, null);
    expect(await done).toEqual({ code: 0, durationMs: 500 });
    expect(handlers.size).toBe(0);
  });
});
