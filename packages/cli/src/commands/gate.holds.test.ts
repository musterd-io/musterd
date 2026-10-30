import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';
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

  it('fails open and records unenforced when the daemon cannot answer — ADR 674 posture', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(bash('git push origin main'));
    http.holdCheck.mockRejectedValue(new CliError("can't reach the daemon", 7));
    http.getEnforcement.mockRejectedValueOnce(new CliError("can't reach the daemon", 7));
    const out = await run();
    expect(out).not.toContain('"permission":"deny"');
    expect(out).toContain('unenforced');
  });
});

describe('ADR 674 — remote hook 60s enforcement cache, per-class outage posture, and recovery flush', () => {
  let dir: string;
  const http = {
    holdCheck: vi.fn(),
    getEnforcement: vi.fn(),
    gateCheck: vi.fn(),
    recordActor: vi.fn().mockResolvedValue(undefined),
  };
  const edit = (file_path: string) =>
    JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: 'Edit',
      tool_input: { file_path },
    });
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
    dir = mkdtempSync(join(tmpdir(), 'musterd-gate-remote-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_TRACE'] = '1';
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CURSOR_AGENT', '');
    for (const f of Object.values(http)) f.mockClear();
    vi.mocked(resolveRead).mockReturnValue({
      http,
      team: 'dawn',
      server: 'https://dawn.musterd.dev',
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

  const policy = {
    classes: [
      {
        class: 'contended-block',
        kind: 'contended-surface' as const,
        match: ['src/blocked/**'],
        posture: 'block' as const,
      },
      {
        class: 'contended-warn',
        kind: 'contended-surface' as const,
        match: ['src/warned/**'],
        posture: 'warn' as const,
      },
      {
        class: 'force-push',
        kind: 'costly-action' as const,
        match: ['git push --force*'],
        posture: 'warn' as const,
      },
    ],
  };

  it('caches the enforcement table for 60s so undeclared calls make zero network round trips', async () => {
    http.getEnforcement.mockResolvedValue({ enforcement: policy });
    vi.mocked(readHookStdin).mockResolvedValue(edit('src/unlisted.ts'));
    await run();
    expect(http.getEnforcement).toHaveBeenCalledTimes(1);
    expect(http.gateCheck).not.toHaveBeenCalled();

    // Second call within 60s uses the local cache and never calls getEnforcement.
    await run();
    expect(http.getEnforcement).toHaveBeenCalledTimes(1);
  });

  it('during an outage, denies block-posture and costly-action classes with "gate unreachable" and allows warn-posture / unclassified calls with per-call "unenforced", then flushes on recovery', async () => {
    // Seed the cache while server is up.
    http.getEnforcement.mockResolvedValueOnce({ enforcement: policy });
    vi.mocked(readHookStdin).mockResolvedValue(edit('src/unlisted.ts'));
    await run();

    // Server goes down for gateCheck on a matched block class → denied with "gate unreachable".
    vi.mocked(readHookStdin).mockResolvedValue(edit('src/blocked/a.ts'));
    http.gateCheck.mockRejectedValueOnce(new CliError("can't reach the daemon", 7));
    const blockOut = await run();
    expect(blockOut).toContain('"permission":"deny"');
    expect(blockOut).toContain('gate unreachable');
    expect(blockOut).toContain('contended-block');

    // Costly-action class during outage → also denied with "gate unreachable".
    vi.mocked(readHookStdin).mockResolvedValue(bash('git push --force origin feat/x'));
    http.gateCheck.mockRejectedValueOnce(new CliError("can't reach the daemon", 7));
    const costlyOut = await run();
    expect(costlyOut).toContain('"permission":"deny"');
    expect(costlyOut).toContain('gate unreachable');
    expect(costlyOut).toContain('force-push');

    // Warn-posture class during outage → allowed and recorded "unenforced" in the tool result.
    vi.mocked(readHookStdin).mockResolvedValue(edit('src/warned/b.ts'));
    http.gateCheck.mockRejectedValueOnce(new CliError("can't reach the daemon", 7));
    const warnOut = await run();
    expect(warnOut).not.toContain('"permission":"deny"');
    expect(warnOut).toContain('unenforced');
    expect(warnOut).toContain('contended-warn');

    // Next call: pending unenforced counter triggers a server probe; while still down on an unclassified call, it also records unenforced.
    vi.mocked(readHookStdin).mockResolvedValue(edit('src/unlisted.ts'));
    http.getEnforcement.mockRejectedValueOnce(new CliError("can't reach the daemon", 7));
    const unclassOut = await run();
    expect(unclassOut).not.toContain('"permission":"deny"');
    expect(unclassOut).toContain('unenforced');

    // Server recovers: the next call refreshes the cache and flushes the 2 unenforced calls as one actor attestation.
    http.getEnforcement.mockResolvedValueOnce({ enforcement: policy });
    await run();
    expect(http.recordActor).toHaveBeenCalledWith(
      'dawn',
      expect.objectContaining({
        kind: 'unenforced',
        count: 2,
        tool: 'Edit',
      }),
    );
  });
});
