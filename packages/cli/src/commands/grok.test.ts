import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';
import { grokSeatLeaderSocket } from '../grokSeatSocket.js';
import type { LaunchPlan } from '../launcher/plan.js';
import { grokCommand } from './grok.js';

describe('musterd grok (ADR 742)', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    dirs.length = 0;
  });

  it('refuses extra words and unknown flags before it looks for grok', async () => {
    await expect(grokCommand(parseArgs(['extra']))).rejects.toThrow(CliError);
    await expect(grokCommand(parseArgs(['--leader']))).rejects.toThrow(/takes no flags/);
  });

  it('starts grok on this folder’s leader socket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-grok-'));
    dirs.push(root);
    const seat = mkdtempSync(join(root, 'seat-'));
    const env = { MUSTERD_CONFIG: join(root, 'config.json') };
    const plans: LaunchPlan[] = [];
    const code = await grokCommand(parseArgs([]), {
      cwd: seat,
      env,
      resolveBin: async () => '/bin/grok',
      supervise: (plan) => {
        plans.push(plan);
        return Promise.resolve({ code: 0, durationMs: 1 });
      },
      write: () => {},
    });
    expect(code).toBe(0);
    const socket = grokSeatLeaderSocket(seat, env);
    expect(plans).toEqual([
      {
        bin: '/bin/grok',
        args: ['--leader', '--leader-socket', socket],
        cwd: seat,
        harness: 'grok',
        env: { GROK_LEADER_SOCKET: socket },
      },
    ]);
  });
});
