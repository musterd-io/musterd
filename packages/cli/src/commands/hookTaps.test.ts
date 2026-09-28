import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { readHookStdin } from '../hookStdin.js';
import { tapHook } from '../trace/hook.js';
import { gateCommand } from './gate.js';
import { inboxCommand } from './inbox.js';

vi.mock('../trace/hook.js', async (orig) => ({
  ...(await orig<typeof import('../trace/hook.js')>()),
  tapHook: vi.fn().mockResolvedValue(true),
}));
vi.mock('../hookStdin.js', () => ({ readHookStdin: vi.fn() }));

/**
 * ADR 445 R1 on Grok (lane 01M3MG7EAM). Which hook records a Grok tool call, and under which
 * harness. The interrupt probe has no matcher, so it is the hook that sees every call; the gate
 * matches write tools only, so on Grok it adds its outcome and leaves the observed event to the
 * probe (one PreToolUse row per call, not two for a write).
 */
describe('Grok hook taps', () => {
  let dir: string;
  const grokPre = JSON.stringify({
    sessionId: 'g1',
    hookEventName: 'PreToolUse',
    toolName: 'read_file',
    toolInput: { path: 'a.ts' },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-taps-'));
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env['MUSTERD_NO_NUDGE'] = '1';
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    // The gate reads the harness from env first; a test run inside a harness must not inherit it.
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CURSOR_AGENT', '');
    vi.mocked(tapHook).mockClear();
    vi.mocked(readHookStdin).mockClear();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    delete process.env['MUSTERD_NO_NUDGE'];
    delete process.env['MUSTERD_CONFIG'];
    rmSync(dir, { recursive: true, force: true });
  });

  it('the probe taps its payload as grok when its hook line says --hook grok', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(grokPre);
    expect(await inboxCommand(parseArgs(['--interrupt-check', '--hook', 'grok']))).toBe(0);
    expect(tapHook).toHaveBeenCalledTimes(1);
    const [raw, opts] = vi.mocked(tapHook).mock.calls[0]!;
    expect(raw).toBe(grokPre);
    expect(opts.harness).toBe('grok');
    expect(opts.observed).not.toBe(false);
    expect(opts.outcome?.hook).toBe('interrupt');
  });

  it('a bare probe still reads no stdin — it cannot tell a harness pipe from any other', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(grokPre);
    await inboxCommand(parseArgs(['--interrupt-check']));
    expect(readHookStdin).not.toHaveBeenCalled();
    expect(tapHook).not.toHaveBeenCalled();
  });

  it('the gate records only its outcome on a Grok payload — the probe owns the observed event', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(
      JSON.stringify({
        sessionId: 'g1',
        hookEventName: 'PreToolUse',
        toolName: 'search_replace',
        toolInput: { path: 'a.ts' },
      }),
    );
    expect(await gateCommand(parseArgs(['check', '--stdin']))).toBe(0);
    const [, opts] = vi.mocked(tapHook).mock.calls[0]!;
    expect(opts.observed).toBe(false);
    expect(opts.outcome?.hook).toBe('gate');
  });

  it('the gate still records the observed event on Claude Code', async () => {
    vi.mocked(readHookStdin).mockResolvedValue(
      JSON.stringify({
        session_id: 's1',
        hook_event_name: 'PreToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: 'a.ts' },
      }),
    );
    await gateCommand(parseArgs(['check', '--stdin']));
    const [, opts] = vi.mocked(tapHook).mock.calls[0]!;
    expect(opts.observed).not.toBe(false);
  });
});
