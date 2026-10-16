import { describe, expect, it } from 'vitest';
import { memoryFs, type HarnessContext } from '../reconcile/context.js';
import { claudeCodeAdapter } from './claudeCode.js';
// ── Fragment adapter (ADR 281/282/286, Task 5) ───────────────────────────────────────────────────

describe('claudeCodeAdapter — managed fragments', () => {
  const ROOT = '/w/a';

  function scriptedExec(script: {
    getOut?: string | null; // null = `claude mcp get musterd` fails (absent)
    calls?: string[][];
  }) {
    const calls: string[][] = script.calls ?? [];
    return {
      calls,
      seam: {
        run: async (_cmd: string, args: string[]) => {
          calls.push(args);
          if (args[0] === '--version') return { ok: true, out: '2.0.0 (Claude Code)' };
          if (args[0] === 'mcp' && args[1] === 'get') {
            return script.getOut == null
              ? { ok: false, out: '' }
              : { ok: true, out: script.getOut };
          }
          return { ok: true, out: '' };
        },
      },
    };
  }

  function fragCtx(fs = memoryFs(), exec = scriptedExec({ getOut: null }).seam): HarnessContext {
    return {
      worktreeRoot: ROOT,
      machineConfigRoot: '/machine/.musterd',
      env: {},
      fs,
      proc: { pid: 1, startedAt: () => 's1', liveness: () => false },
      clock: { now: () => 1 },
      exec,
      team: 'dawn',
    };
  }

  it('emits one fingerprinted fragment per managed unit — MCP entry, local hooks, global hooks, permissions, guidance', async () => {
    const ctx = fragCtx();
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    expect(intents.map((i) => i.fragmentKey).sort()).toEqual([
      'guidance',
      'hooks.global',
      'hooks.local',
      'mcp.musterd',
      'permissions',
    ]);
    for (const intent of intents) expect(intent.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    // The repo-shared registration is modeled separately from every folder fragment.
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect(mcp.scope).toBe('repo-shared');
    expect(intents.filter((i) => i.scope === 'folder').length).toBe(3);
    expect(intents.find((i) => i.fragmentKey === 'hooks.global')!.scope).toBe('machine');
  });

  it('the desired MCP entry carries exactly MUSTERD_LAUNCH_SURFACE — never the retired or test marker', async () => {
    const ctx = fragCtx();
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    const env = (mcp.payload as { env: Record<string, string> }).env;
    expect(env['MUSTERD_LAUNCH_SURFACE']).toBe('claude-code');
    expect(Object.keys(env)).toEqual(['MUSTERD_LAUNCH_SURFACE']);
  });

  it('identifies an old musterd entry carrying MUSTERD_SURFACE as legacy-launch-marker', async () => {
    const exec = scriptedExec({
      getOut: [
        'musterd:',
        '  Scope: Local',
        '  Command: /usr/local/bin/node',
        '  Args: /repo/packages/mcp/dist/index.js',
        '  Environment:',
        '    MUSTERD_SURFACE=claude-code',
      ].join('\n'),
    });
    const ctx = fragCtx(memoryFs(), exec.seam);
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    const observed = await claudeCodeAdapter.observe(
      ctx,
      intents.find((i) => i.fragmentKey === 'mcp.musterd')!,
    );
    expect(observed.state).toBe('legacy-launch-marker');
  });

  it('a MARKER-LESS musterd entry (the ADR 165 shape) is pre-ADR-286 too — legacy, repairable', async () => {
    // The common fleet registration: ADR 165 stripped every env var, so the entry carries neither
    // the launch marker nor the retired one. Classifying it 'present' made configure refuse as
    // unmanaged-conflict, and the conversion could not complete anywhere (nick's first real run).
    const exec = scriptedExec({
      getOut: ['  Command: /their/node', '  Args: /their/adapter.js'].join('\n'),
    });
    const ctx = fragCtx(memoryFs(), exec.seam);
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect((await claudeCodeAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');
    await claudeCodeAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const add = exec.calls.find((c) => c[0] === 'mcp' && c[1] === 'add')!;
    const joined = add.join(' ');
    expect(joined).toContain('MUSTERD_LAUNCH_SURFACE=claude-code');
    expect(joined).toContain('/their/node'); // repaired, not adopted
  });

  it('repair-launch-marker preserves the observed command/args and unrelated env, swapping only the marker', async () => {
    const exec = scriptedExec({
      getOut: [
        '  Command: /their/node',
        '  Args: /their/adapter.js --flag',
        '    MUSTERD_SURFACE=claude-code',
        '    MUSTERD_GRANT=msgr_keepme',
      ].join('\n'),
    });
    const ctx = fragCtx(memoryFs(), exec.seam);
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    await claudeCodeAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const add = exec.calls.find((c) => c[0] === 'mcp' && c[1] === 'add')!;
    const joined = add.join(' ');
    expect(joined).toContain('MUSTERD_LAUNCH_SURFACE=claude-code');
    expect(joined).not.toContain('MUSTERD_SURFACE=');
    expect(joined).toContain('MUSTERD_GRANT=msgr_keepme'); // unrelated env preserved
    expect(joined).toContain('/their/node');
    expect(joined).toContain('--flag');
  });

  it('hook and permission fragments preserve unrelated settings across write and remove', async () => {
    const fs = memoryFs();
    const path = '/w/a/.claude/settings.local.json';
    fs.writeFile(
      path,
      JSON.stringify({
        theirKey: { keep: true },
        permissions: { allow: ['TheirTool'], deny: ['Dangerous'] },
        hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'their-hook.sh' }] }] },
      }),
      0o600,
    );
    const ctx = fragCtx(fs);
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    const hooks = intents.find((i) => i.fragmentKey === 'hooks.local')!;
    const permissions = intents.find((i) => i.fragmentKey === 'permissions')!;

    await claudeCodeAdapter.apply(ctx, { kind: 'write', intent: hooks });
    await claudeCodeAdapter.apply(ctx, { kind: 'write', intent: permissions });
    let parsed = JSON.parse(fs.readFile(path)!);
    expect(parsed.theirKey).toEqual({ keep: true });
    expect(parsed.permissions.allow).toContain('TheirTool');
    expect(parsed.permissions.allow).toContain('Read');
    expect(
      parsed.hooks.PostToolUse.some((m: { hooks: { command: string }[] }) =>
        m.hooks.some((h) => h.command === 'their-hook.sh'),
      ),
    ).toBe(true);
    // Now observed as exactly the intent (both fragments read back their own fingerprints).
    expect(await claudeCodeAdapter.observe(ctx, hooks)).toEqual({
      state: 'present',
      fingerprint: hooks.fingerprint,
    });
    expect(await claudeCodeAdapter.observe(ctx, permissions)).toEqual({
      state: 'present',
      fingerprint: permissions.fingerprint,
    });

    await claudeCodeAdapter.apply(ctx, { kind: 'remove', intent: hooks });
    await claudeCodeAdapter.apply(ctx, { kind: 'remove', intent: permissions });
    parsed = JSON.parse(fs.readFile(path)!);
    expect(parsed.theirKey).toEqual({ keep: true });
    expect(parsed.permissions.allow).toEqual(['TheirTool']);
    expect(parsed.permissions.deny).toEqual(['Dangerous']);
    expect(parsed.hooks.PostToolUse).toHaveLength(1);
    expect(await claudeCodeAdapter.observe(ctx, hooks)).toEqual({ state: 'absent' });
  });

  it('permissions observe folds the three wildcard spellings — a no-space floor IS complete (ADR 633)', async () => {
    // The live trap (stanley's workspace, 2026-10-16): every floor entry present, five of them
    // only as `Bash(pnpm test*)`-style bare-star spellings a human or older tool wrote. The
    // raw-string observer called the subset incomplete → unmanaged-conflict forever, while the
    // ADR 261 merge — the same file, same entries — reported "nothing to add".
    const fs = memoryFs();
    const ctx = fragCtx(fs);
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    const permissions = intents.find((i) => i.fragmentKey === 'permissions')!;
    const desired = permissions.payload as { allow: string[]; ask: string[]; deny: string[] };
    const bareStar = (entry: string) => entry.replace(/ \*\)$/, '*)');
    fs.writeFile(
      '/w/a/.claude/settings.local.json',
      JSON.stringify({
        permissions: { allow: desired.allow.map(bareStar), ask: desired.ask, deny: desired.deny },
      }),
      0o600,
    );
    // Complete in alternate spellings → the intent fingerprint → unmanaged-equivalent → green.
    expect(await claudeCodeAdapter.observe(ctx, permissions)).toEqual({
      state: 'present',
      fingerprint: permissions.fingerprint,
    });
    // One genuinely absent entry (not an alternate spelling) still observes incomplete.
    fs.writeFile(
      '/w/a/.claude/settings.local.json',
      JSON.stringify({
        permissions: {
          allow: desired.allow.filter((e) => e !== 'Read').map(bareStar),
          ask: desired.ask,
          deny: desired.deny,
        },
      }),
      0o600,
    );
    const partial = await claudeCodeAdapter.observe(ctx, permissions);
    expect(partial.state).toBe('present');
    if (partial.state === 'present') expect(partial.fingerprint).not.toBe(permissions.fingerprint);
  });

  it('guidance renders as a deterministic stamped file map, observed byte-exactly', async () => {
    const fs = memoryFs();
    const ctx = fragCtx(fs);
    const intents = await claudeCodeAdapter.desiredFragments(
      ctx,
      await claudeCodeAdapter.target(ctx),
    );
    const guidance = intents.find((i) => i.fragmentKey === 'guidance')!;
    expect(await claudeCodeAdapter.observe(ctx, guidance)).toEqual({ state: 'absent' });
    await claudeCodeAdapter.apply(ctx, { kind: 'write', intent: guidance });
    expect(fs.readFile('/w/a/.claude/skills/musterd/SKILL.md')).toContain('musterd:content');
    expect(await claudeCodeAdapter.observe(ctx, guidance)).toEqual({
      state: 'present',
      fingerprint: guidance.fingerprint,
    });
    // A hand-edit drifts the fragment: same state, different fingerprint.
    fs.writeFile('/w/a/.claude/skills/musterd/SKILL.md', 'edited by hand\n', 0o644);
    const observed = await claudeCodeAdapter.observe(ctx, guidance);
    expect(observed.state).toBe('present');
    if (observed.state === 'present') expect(observed.fingerprint).not.toBe(guidance.fingerprint);
  });
});
