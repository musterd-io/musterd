import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';
import { readHookStdin } from '../hookStdin.js';
import { gateCommand, writeEnforcementCache } from './gate.js';
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
 * ADR 801 at the hook: the seat's own open blocking approve ask is checked before the class table. A
 * matching call goes to the daemon as `kind: 'ask-withhold'`, and a deny there is the PreToolUse deny.
 * On outage a cached withhold still denies (§5). A call that matches nothing never asks.
 */
describe('the gate and an open blocking ask (ADR 801)', () => {
  let dir: string;
  const future = Date.now() + 60 * 60_000;
  const wide = {
    ask_id: 'ask-1',
    commands: [],
    paths: [],
    seat_wide: true,
    declined: false,
    expires_at: future,
  };
  const http = {
    holdCheck: vi.fn(),
    getEnforcement: vi.fn(),
    gateCheck: vi.fn(),
    recordActor: vi.fn().mockResolvedValue(undefined),
  };
  const call = (tool: string, input: Record<string, unknown>) =>
    JSON.stringify({
      session_id: 's1',
      hook_event_name: 'PreToolUse',
      tool_name: tool,
      tool_input: input,
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
    dir = mkdtempSync(join(tmpdir(), 'musterd-gate-withhold-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_TRACE'] = '1';
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CURSOR_AGENT', '');
    for (const f of Object.values(http)) f.mockReset();
    http.recordActor.mockResolvedValue(undefined);
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

  it("denies a write the seat's own ask withholds, with the daemon's sentence", async () => {
    vi.mocked(readHookStdin).mockResolvedValue(call('Edit', { file_path: join(dir, 'a.ts') }));
    http.getEnforcement.mockResolvedValue({ enforcement: { classes: [] }, withholds: [wide] });
    http.gateCheck.mockResolvedValue({
      decision: 'deny',
      outcome: 'denied_awaiting',
      reason: 'held by your own blocking ask ask-1 (ADR 801): wait for a human answer.',
      ask_ref: 'ask-1',
    });
    const out = await run();
    expect(http.gateCheck).toHaveBeenCalledWith(
      'dawn',
      expect.objectContaining({ kind: 'ask-withhold', ask_ref: 'ask-1', posture: 'block' }),
    );
    expect(out).toContain('held by your own blocking ask ask-1');
    expect(out).toContain('deny');
  });

  it('lets the call through when the daemon says the ask no longer holds it', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(call('Edit', { file_path: join(dir, 'a.ts') }));
    http.getEnforcement.mockResolvedValue({ enforcement: { classes: [] }, withholds: [wide] });
    http.gateCheck.mockResolvedValue({ decision: 'allow', outcome: 'released', reason: '' });
    const out = await run();
    expect(out).not.toContain('"permissionDecision":"deny"');
  });

  it('never asks about a read, even while a seat-wide withhold is open', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(call('Bash', { command: 'git status' }));
    http.getEnforcement.mockResolvedValue({ enforcement: { classes: [] }, withholds: [wide] });
    await run();
    expect(http.gateCheck).not.toHaveBeenCalled();
  });

  it('on outage, a cached withhold still denies — fail closed (§5)', async () => {
    writeEnforcementCache(join(dir, '.musterd'), 'dawn', undefined, { classes: [] }, 0, [wide]);
    vi.mocked(readHookStdin).mockResolvedValue(call('Bash', { command: 'rm -rf build' }));
    http.getEnforcement.mockRejectedValue(new CliError("can't reach the daemon", 7));
    const out = await run();
    expect(out).toContain('gate unreachable');
    expect(out).toContain('ask-1');
    expect(out).toContain('deny');
  });
});
