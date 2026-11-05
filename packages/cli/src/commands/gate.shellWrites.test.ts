import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * ADR 803 at the hook. A `Bash` call's plainly named targets go through Gate A like a file-tool write
 * (§2), several of them in one request. An opaque call, while a `block` surface is declared, gets the
 * advisory and a work-tree snapshot (§3); the PostToolUse hook then sends each newly changed `block`
 * path as `after: true` and reads the daemon's `written_unowned` repair back to the seat.
 */
describe('the gate and shell writes (ADR 803)', () => {
  let dir: string;
  const protocol = {
    class: 'protocol',
    kind: 'contended-surface',
    match: ['packages/protocol/src/**'],
    posture: 'block',
  };
  const packages = {
    class: 'packages',
    kind: 'contended-surface',
    match: ['packages/**'],
    posture: 'warn',
  };
  const http = {
    holdCheck: vi.fn(),
    getEnforcement: vi.fn(),
    gateCheck: vi.fn(),
    recordActor: vi.fn().mockResolvedValue(undefined),
    reportPush: vi.fn(),
  };
  const payload = (event: string, command: string) =>
    JSON.stringify({
      session_id: 's1',
      tool_use_id: 'toolu_1',
      cwd: dir,
      hook_event_name: event,
      tool_name: 'Bash',
      tool_input: { command },
    });
  async function run(args: string[]): Promise<string> {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
      chunks.push(String(c));
      return true;
    });
    try {
      await gateCommand(parseArgs(args));
      return chunks.join('');
    } finally {
      spy.mockRestore();
    }
  }
  const pre = (command: string) => {
    vi.mocked(readHookStdin).mockResolvedValue(payload('PreToolUse', command));
    return run(['check', '--stdin']);
  };
  const post = (command: string) => {
    vi.mocked(readHookStdin).mockResolvedValue(payload('PostToolUse', command));
    return run(['record-push', '--stdin']);
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'musterd-gate-shell-'));
    git('init', '-q');
    mkdirSync(join(dir, 'packages/protocol/src'), { recursive: true });
    writeFileSync(join(dir, 'packages/protocol/src/x.ts'), 'a\n');
    writeFileSync(join(dir, '.gitignore'), '.musterd/\n');
    git('add', '.');
    git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    process.env['MUSTERD_CONFIG'] = join(dir, 'config.json');
    process.env['MUSTERD_NO_TRACE'] = '1';
    vi.stubEnv('CLAUDECODE', '');
    vi.stubEnv('CURSOR_AGENT', '');
    for (const f of Object.values(http)) f.mockReset();
    http.recordActor.mockResolvedValue(undefined);
    http.getEnforcement.mockResolvedValue({
      enforcement: { classes: [protocol, packages] },
      withholds: [],
    });
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

  it('a sed -i on a block path is weighed by Gate A, and its deny is the deny', async () => {
    http.gateCheck.mockResolvedValue({
      decision: 'deny',
      outcome: 'denied',
      reason:
        "blocked: 'protocol' is a declared contended surface you have not claimed a lane for.",
    });
    const out = await pre("sed -i '' 's/a/b/' packages/protocol/src/x.ts");
    expect(http.gateCheck).toHaveBeenCalledTimes(1);
    expect(http.gateCheck).toHaveBeenCalledWith(
      'dawn',
      expect.objectContaining({
        kind: 'contended-surface',
        class: 'protocol',
        posture: 'block',
        tool: 'Bash',
        target: 'packages/protocol/src/x.ts',
      }),
    );
    expect(out).toContain('"permissionDecision":"deny"');
  });

  it('a relative path resolves against the shell directory, made repo-relative', async () => {
    http.gateCheck.mockResolvedValue({ decision: 'allow', outcome: 'allowed', reason: '' });
    vi.mocked(readHookStdin).mockResolvedValue(
      JSON.stringify({
        session_id: 's1',
        cwd: join(dir, 'packages/protocol'),
        tool_name: 'Bash',
        tool_input: { command: 'echo x > src/x.ts' },
      }),
    );
    await run(['check', '--stdin']);
    expect(http.gateCheck).toHaveBeenCalledWith(
      'dawn',
      expect.objectContaining({ target: 'packages/protocol/src/x.ts' }),
    );
  });

  it('several named paths are one request, the block path first, the rest in `also`', async () => {
    http.gateCheck.mockResolvedValue({ decision: 'allow', outcome: 'allowed', reason: '' });
    await pre('cp README.md packages/cli/a.md && touch packages/protocol/src/y.ts');
    expect(http.gateCheck).toHaveBeenCalledTimes(1);
    const req = http.gateCheck.mock.calls[0]![1];
    expect(req).toMatchObject({ class: 'protocol', target: 'packages/protocol/src/y.ts' });
    expect(req.also).toEqual([
      expect.objectContaining({ class: 'packages', target: 'packages/cli/a.md' }),
    ]);
  });

  it('more paths than one request carries are sent in more requests, none dropped', async () => {
    http.gateCheck.mockResolvedValue({ decision: 'allow', outcome: 'allowed', reason: '' });
    const files = Array.from({ length: 20 }, (_, i) => `packages/protocol/src/f${i}.ts`);
    await pre(`touch ${files.join(' ')}`);
    const sent = http.gateCheck.mock.calls.flatMap(([, req]) => [
      req.target,
      ...(req.also ?? []).map((a: { target: string }) => a.target),
    ]);
    expect(http.gateCheck).toHaveBeenCalledTimes(2);
    expect(sent.sort()).toEqual([...files].sort());
  });

  it('a read never reaches the daemon', async () => {
    await pre('grep -n "> x" packages/protocol/src/x.ts');
    expect(http.gateCheck).not.toHaveBeenCalled();
  });

  it('an opaque write: advisory before, snapshot kept; after, a new block-path change is reported', async () => {
    const out = await pre(`python3 -c "open('packages/protocol/src/x.ts','w')"`);
    expect(http.gateCheck).not.toHaveBeenCalled();
    expect(out).toContain('cannot tell which files this command writes');
    expect(out).toContain("'protocol'");
    expect(readdirSync(join(dir, '.musterd/shell-writes'))).toHaveLength(1);

    writeFileSync(join(dir, 'packages/protocol/src/x.ts'), 'changed\n');
    http.gateCheck.mockResolvedValue({
      decision: 'allow',
      outcome: 'written_unowned',
      reason: "written: that command changed 'packages/protocol/src/x.ts' …",
    });
    const after = await post(`python3 -c "open('packages/protocol/src/x.ts','w')"`);
    expect(http.gateCheck).toHaveBeenCalledWith(
      'dawn',
      expect.objectContaining({
        kind: 'contended-surface',
        class: 'protocol',
        target: 'packages/protocol/src/x.ts',
        after: true,
      }),
    );
    expect(after).toContain('PostToolUse');
    expect(after).toContain("changed 'packages/protocol/src/x.ts'");
    expect(readdirSync(join(dir, '.musterd/shell-writes'))).toHaveLength(0);
  });

  it('a path already changed before the call counts only if the call touched it again', async () => {
    writeFileSync(join(dir, 'packages/protocol/src/x.ts'), 'dirty before\n');
    await pre('node -e "1"');
    await post('node -e "1"');
    expect(http.gateCheck).not.toHaveBeenCalled();
  });

  it('with no block surface declared, an opaque call costs nothing', async () => {
    http.getEnforcement.mockResolvedValue({ enforcement: { classes: [packages] }, withholds: [] });
    const out = await pre('python3 gen.py');
    expect(out).toBe('');
    expect(() => readdirSync(join(dir, '.musterd/shell-writes'))).toThrow();
  });

  it('a path withhold holds a shell write to that path (§4)', async () => {
    http.getEnforcement.mockResolvedValue({
      enforcement: { classes: [] },
      withholds: [
        {
          ask_id: 'ask-1',
          commands: [],
          paths: ['docs/**'],
          seat_wide: false,
          declined: false,
          expires_at: Date.now() + 60_000,
        },
      ],
    });
    http.gateCheck.mockResolvedValue({
      decision: 'deny',
      outcome: 'denied_awaiting',
      reason: 'held by your own blocking ask ask-1',
    });
    const out = await pre("sed -i 's/a/b/' docs/x.md");
    expect(http.gateCheck).toHaveBeenCalledWith(
      'dawn',
      expect.objectContaining({ kind: 'ask-withhold', ask_ref: 'ask-1', target: 'docs/x.md' }),
    );
    expect(out).toContain('held by your own blocking ask ask-1');
  });
});
