import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { readHookStdin } from '../hookStdin.js';
import { gateCommand } from './gate.js';
import { resolveRead } from './helpers.js';

vi.mock('../trace/hook.js', async (orig) => ({
  ...(await orig<typeof import('../trace/hook.js')>()),
  tapHook: vi.fn().mockResolvedValue(true),
}));
vi.mock('../hookStdin.js', () => ({ readHookStdin: vi.fn() }));
vi.mock('./helpers.js', async (orig) => ({
  ...(await orig<typeof import('./helpers.js')>()),
  resolveRead: vi.fn(),
}));

/**
 * ADR 516 increment 2 at the hook: a merge-shaped command asks the daemon before it runs, and a
 * `denied_held` answer becomes the PreToolUse deny, word for word. Anything else never asks — the
 * gate rides every tool call, so the hold check must cost nothing off the merge path.
 */
describe('the gate and a merges hold (ADR 516 increment 2)', () => {
  let dir: string;
  const http = {
    holdCheck: vi.fn(),
    getEnforcement: vi.fn().mockResolvedValue({ enforcement: { classes: [] } }),
    gateCheck: vi.fn(),
    recordActor: vi.fn(),
  };
  const bash = (command: string) =>
    JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command },
    });
  async function run(): Promise<string> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      await gateCommand(parseArgs(['check', '--stdin']));
      return chunks.join('');
    } finally {
      spy.mockRestore();
    }
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-gate-holds-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_TRACE'] = '1';
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CURSOR_AGENT', '');
    for (const f of Object.values(http)) f.mockClear();
    vi.mocked(resolveRead).mockReturnValue({
      http,
      team: 'dawn',
      identity: { name: 'ada' },
      explicit: true,
    } as never);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env['MUSTERD_CONFIG'];
    delete process.env['MUSTERD_NO_TRACE'];
    rmSync(dir, { recursive: true, force: true });
  });

  it("denies a merge with the daemon's sentence while merges are held", async () => {
    vi.mocked(readHookStdin).mockResolvedValue(bash('gh pr merge 12 --squash'));
    http.holdCheck.mockResolvedValue({
      decision: 'deny',
      outcome: 'denied_held',
      reason: 'held by nick until 15:30: demo 14:00 — merges are paused for the Team.',
    });
    const out = await run();
    expect(http.holdCheck).toHaveBeenCalledWith('dawn', {
      tool: 'Bash',
      command: 'gh pr merge 12 --squash',
    });
    expect(out).toContain('held by nick until 15:30: demo 14:00');
    expect(out).toContain('deny');
    expect(http.getEnforcement).not.toHaveBeenCalled();
  });

  it('lets the merge through when the daemon allows it, and goes on to the class table', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(bash('gh pr merge 12 --squash'));
    http.holdCheck.mockResolvedValue({ decision: 'allow', outcome: 'allowed', reason: '' });
    const out = await run();
    expect(out).not.toContain('deny');
    expect(http.getEnforcement).toHaveBeenCalled();
  });

  it('never asks about holds for a command that is not a merge', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(bash('git push --force-with-lease origin feat/x'));
    await run();
    expect(http.holdCheck).not.toHaveBeenCalled();
  });

  it('fails open when the daemon cannot answer — the ADR 150 posture', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(bash('git push origin main'));
    http.holdCheck.mockRejectedValue(new Error('connect ECONNREFUSED'));
    expect(await run()).not.toContain('deny');
  });
});
