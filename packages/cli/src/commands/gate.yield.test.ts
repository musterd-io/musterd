import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { readHookStdin } from '../hookStdin.js';
import { writeYieldFile } from '../launcher/yield.js';
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

/** ADR 546 at the hook: a yield marker naming this wake's lease denies its next tool call. */
describe('the gate and a wake a person took over (ADR 546)', () => {
  let dir: string;
  const http = {
    getEnforcement: vi.fn().mockResolvedValue({ enforcement: { classes: [] } }),
    gateCheck: vi.fn(),
    holdCheck: vi.fn(),
    recordActor: vi.fn(),
  };
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
    dir = mkdtempSync(join(tmpdir(), 'musterd-gate-yield-'));
    mkdirSync(join(dir, '.musterd'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_TRACE'] = '1';
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CURSOR_AGENT', '');
    vi.mocked(readHookStdin).mockResolvedValue(
      JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
      }),
    );
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

  it('denies the wake the marker names, with the person who took over', async () => {
    writeYieldFile(dir, { lease_id: 'L1', by: 'nick', at: 1 });
    vi.stubEnv('MUSTERD_WAKE_LEASE', 'L1');
    expect(await run()).toContain('nick has taken over this seat');
  });

  it("does not deny a person's own session in the same folder", async () => {
    writeYieldFile(dir, { lease_id: 'L1', by: 'nick', at: 1 });
    vi.stubEnv('MUSTERD_WAKE_LEASE', '');
    expect(await run()).not.toContain('taken over');
  });

  it('does not deny a later wake with a different lease', async () => {
    writeYieldFile(dir, { lease_id: 'L1', by: 'nick', at: 1 });
    vi.stubEnv('MUSTERD_WAKE_LEASE', 'L2');
    expect(await run()).not.toContain('taken over');
  });
});
