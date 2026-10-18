import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURE_EPOCH } from '@musterd/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { memoryFs, nodeFs, type HarnessContext, type MemoryFs } from '../reconcile/context.js';
import { codexAdapter } from './codex.js';
import { CODEX_HOOK_MARKER, codexHookCommands } from './codexHooks.js';
import type { CodexServer } from './codexToml.js';

const ROOT = '/w/a';
const TOML = '/w/a/.codex/config.toml';
const HOOKS = '/w/a/.codex/hooks.json';
const realRoots: string[] = [];

afterEach(() => {
  for (const root of realRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function ctxOf(fs: MemoryFs): HarnessContext {
  return {
    worktreeRoot: ROOT,
    machineConfigRoot: '/machine/.musterd',
    env: { HOME: '/home/u' },
    fs,
    proc: { pid: 1, startedAt: () => 's1', liveness: () => false },
    clock: { now: () => 1 },
    team: 'dawn',
  };
}

async function intentsOf(ctx: HarnessContext) {
  return codexAdapter.desiredFragments(ctx, await codexAdapter.target(ctx));
}

const THEIR_TOML = [
  '# the user’s own comment,   spacing and all',
  'model = "o5"',
  '',
  '[projects."/w/a"]',
  'trust_level = "trusted"',
  '',
  '[mcp_servers.figma]',
  'command = "npx"',
  'args = ["figma-mcp"]',
  '',
].join('\n');

describe('codexAdapter — the ADR 658 permission set', () => {
  it('writes the store denies as a selected profile, observes it back, and removes only its own', async () => {
    const fs = memoryFs();
    fs.writeFile(TOML, THEIR_TOML, 0o644);
    const ctx = ctxOf(fs);
    const intent = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'permissions')!;
    const payload = intent.payload as { deny: string[]; selected: boolean };
    expect(payload.selected).toBe(true);
    expect(payload.deny).toContain('~/.musterd/musterd.db-wal');
    expect(payload.deny).toContain('~/.musterd/note-key.json');
    expect(await codexAdapter.observe(ctx, intent)).toEqual({ state: 'absent' });

    await codexAdapter.apply(ctx, { kind: 'write', intent });
    const written = fs.readFile(TOML)!;
    expect(written).toContain('default_permissions = "musterd"');
    expect(written).toContain('"~/.musterd/trace.db" = "deny"');
    expect(written).toContain(THEIR_TOML.trim());
    expect(await codexAdapter.observe(ctx, intent)).toEqual({
      state: 'present',
      fingerprint: intent.fingerprint,
    });
    // Re-deriving after the write still selects it: musterd's own default_permissions is not a
    // human's choice to defer to.
    const again = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'permissions')!;
    expect(again.fingerprint).toBe(intent.fingerprint);

    await codexAdapter.apply(ctx, { kind: 'remove', intent });
    expect(fs.readFile(TOML)!.trim()).toBe(THEIR_TOML.trim());
  });

  it("defers to a human's own sandbox choice — the profile is written but not selected", async () => {
    for (const line of [
      'sandbox_mode = "workspace-write"',
      'default_permissions = ":read-only"',
      '[sandbox_workspace_write]\nnetwork_access = true',
    ]) {
      const fs = memoryFs();
      fs.writeFile(TOML, `${line}\n\n${THEIR_TOML}`, 0o644);
      const ctx = ctxOf(fs);
      const intent = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'permissions')!;
      expect((intent.payload as { selected: boolean }).selected).toBe(false);
      await codexAdapter.apply(ctx, { kind: 'write', intent });
      expect(fs.readFile(TOML)!).not.toContain('default_permissions = "musterd"');
      expect(fs.readFile(TOML)!).toContain(line);
    }
  });
});

describe('codexAdapter — managed fragments', () => {
  it('exposes the musterd MCP table and the hooks as distinct fragments', async () => {
    const intents = await intentsOf(ctxOf(memoryFs()));
    expect(intents.map((i) => i.fragmentKey).sort()).toEqual([
      'hooks',
      'mcp.musterd',
      'permissions',
    ]);
    expect(new Set(intents.map((i) => i.containerKey)).size).toBe(2);
    const payload = intents.find((i) => i.fragmentKey === 'mcp.musterd')!.payload as CodexServer;
    expect(payload.env).toEqual({ MUSTERD_LAUNCH_SURFACE: 'codex' });
    // ADR 495: a headless wake cannot answer a tool-approval prompt, so the entry approves its own.
    expect(payload.default_tools_approval_mode).toBe('approve');
  });

  it('an owned entry from before ADR 495 observes as a different fingerprint, so reconcile updates it', async () => {
    const fs = memoryFs();
    fs.writeFile(
      TOML,
      [
        '[mcp_servers.musterd]',
        'command = "/n"',
        'args = ["/a.js"]',
        '',
        '[mcp_servers.musterd.env]',
        'MUSTERD_LAUNCH_SURFACE = "codex"',
        '',
        '[mcp_servers.musterd.tools.team_join]',
        'approval_mode = "approve"',
        '',
      ].join('\n'),
      0o600,
    );
    const ctx = ctxOf(fs);
    const mcp = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'mcp.musterd')!;
    const before = await codexAdapter.observe(ctx, mcp);
    expect(before.state).toBe('present');
    expect(before.state === 'present' && before.fingerprint).not.toBe(mcp.fingerprint);

    await codexAdapter.apply(ctx, { kind: 'write', intent: mcp });
    const after = fs.readFile(TOML)!;
    expect(after).toContain('default_tools_approval_mode = "approve"');
    expect(after).toContain('[mcp_servers.musterd.tools.team_join]'); // a hand repair survives
    expect(await codexAdapter.observe(ctx, mcp)).toEqual({
      state: 'present',
      fingerprint: mcp.fingerprint,
    });
  });

  it('unrelated TOML sections and bytes remain unchanged, including comments and ordering', async () => {
    const fs = memoryFs();
    fs.writeFile(TOML, THEIR_TOML, 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect(await codexAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });

    await codexAdapter.apply(ctx, { kind: 'write', intent: mcp });
    const after = fs.readFile(TOML)!;
    expect(after.startsWith(THEIR_TOML.trimEnd())).toBe(true); // their bytes verbatim, comments included
    expect(after).toContain('[mcp_servers.musterd]');
    expect(after).toContain('MUSTERD_LAUNCH_SURFACE = "codex"');
    expect(after).toContain('default_tools_approval_mode = "approve"');
    expect(await codexAdapter.observe(ctx, mcp)).toEqual({
      state: 'present',
      fingerprint: mcp.fingerprint,
    });

    await codexAdapter.apply(ctx, { kind: 'remove', intent: mcp });
    const removed = fs.readFile(TOML)!;
    expect(removed).toContain('[mcp_servers.figma]');
    expect(removed).not.toContain('mcp_servers.musterd');
    expect(removed).toContain('# the user’s own comment,   spacing and all');
  });

  it('refuses an invalid intended table shape before opening the write path — prior bytes unchanged', async () => {
    const fs = memoryFs();
    fs.writeFile(TOML, THEIR_TOML, 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    const poisoned = {
      ...mcp,
      payload: { command: '', args: 'not-a-list', env: { X: 42 } },
    };
    await expect(codexAdapter.apply(ctx, { kind: 'write', intent: poisoned })).rejects.toThrow(
      /refusing to write an invalid Codex mcp_servers\.musterd/,
    );
    expect(fs.readFile(TOML)).toBe(THEIR_TOML);
  });

  it('a musterd table carrying MUSTERD_SURFACE observes as legacy-launch-marker; repair swaps only the marker', async () => {
    const fs = memoryFs();
    fs.writeFile(
      TOML,
      [
        THEIR_TOML.trimEnd(),
        '',
        '[mcp_servers.musterd]',
        'command = "/their/node"',
        'args = ["/their/adapter.js"]',
        '',
        '[mcp_servers.musterd.env]',
        'MUSTERD_SURFACE = "codex"',
        'MUSTERD_GRANT = "msgr_keep"',
        '',
      ].join('\n'),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect((await codexAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');

    await codexAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const after = fs.readFile(TOML)!;
    expect(after).toContain('MUSTERD_LAUNCH_SURFACE = "codex"');
    expect(after).not.toMatch(/MUSTERD_SURFACE =/);
    expect(after).toContain('MUSTERD_GRANT = "msgr_keep"'); // unrelated env preserved
    expect(after).toContain('command = "/their/node"'); // the entry is repaired, not adopted
    expect(after).toContain('[mcp_servers.figma]');
  });

  it('a marker-less musterd table (the ADR 165 shape) is pre-ADR-286 — legacy, marker-only repair', async () => {
    const fs = memoryFs();
    fs.writeFile(
      TOML,
      [
        THEIR_TOML.trimEnd(),
        '',
        '[mcp_servers.musterd]',
        'command = "/their/node"',
        'args = ["/their/adapter.js"]',
        '',
      ].join('\n'),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect((await codexAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');
    await codexAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const after = fs.readFile(TOML)!;
    expect(after).toContain('MUSTERD_LAUNCH_SURFACE = "codex"');
    expect(after).toContain('command = "/their/node"'); // repaired, not adopted
    expect(after).toContain('[mcp_servers.figma]');
  });

  it('hook fragments add and remove only marker-owned handlers', async () => {
    const fs = memoryFs();
    fs.writeFile(
      HOOKS,
      JSON.stringify({
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'their-hook.sh' }] }] },
        theirTopLevel: true,
      }),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const hooks = intents.find((i) => i.fragmentKey === 'hooks')!;

    await codexAdapter.apply(ctx, { kind: 'write', intent: hooks });
    let parsed = JSON.parse(fs.readFile(HOOKS)!);
    expect(parsed.theirTopLevel).toBe(true);
    expect(
      parsed.hooks.SessionStart.some((g: { hooks: { command: string }[] }) =>
        g.hooks.some((h) => h.command === 'their-hook.sh'),
      ),
    ).toBe(true);
    expect(parsed.hooks.PostToolUse).toBeDefined();
    expect(await codexAdapter.observe(ctx, hooks)).toEqual({
      state: 'present',
      fingerprint: hooks.fingerprint,
    });

    await codexAdapter.apply(ctx, { kind: 'remove', intent: hooks });
    parsed = JSON.parse(fs.readFile(HOOKS)!);
    expect(parsed.hooks.SessionStart).toEqual([
      { hooks: [{ type: 'command', command: 'their-hook.sh' }] },
    ]);
    expect(parsed.hooks.PostToolUse).toBeUndefined();
    expect(await codexAdapter.observe(ctx, hooks)).toEqual({ state: 'absent' });
  });

  it('does not downgrade a newer marker-owned hook set', async () => {
    const fs = memoryFs();
    const ctx = ctxOf(fs);
    const hooks = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'hooks')!;
    const newer = JSON.stringify({
      hooks: Object.fromEntries(
        codexHookCommands().map(({ event, command }) => [
          event,
          [
            {
              hooks: [
                {
                  type: 'command',
                  command: command.replace(
                    new RegExp(`${CODEX_HOOK_MARKER}(?: e\\d+)?$`),
                    `${CODEX_HOOK_MARKER} e${FEATURE_EPOCH + 1}`,
                  ),
                },
              ],
            },
          ],
        ]),
      ),
    });
    fs.writeFile(HOOKS, newer, 0o600);

    await codexAdapter.apply(ctx, { kind: 'write', intent: hooks });

    expect(fs.readFile(HOOKS)).toBe(newer);
  });

  it('preflights the common-dir epoch before declarative apply writes either worktree copy', async () => {
    const main = mkdtempSync(join(tmpdir(), 'musterd-codex-fragment-main-'));
    const worktree = mkdtempSync(join(tmpdir(), 'musterd-codex-fragment-worktree-'));
    realRoots.push(main, worktree);
    writeFileSync(join(worktree, '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'seat')}\n`);
    mkdirSync(join(worktree, '.codex'));
    mkdirSync(join(main, '.codex'));
    const hooksFor = (epoch: number) =>
      JSON.stringify({
        hooks: Object.fromEntries(
          codexHookCommands().map(({ event, command }) => [
            event,
            [
              {
                hooks: [
                  {
                    type: 'command',
                    command: command.replace(
                      new RegExp(`${CODEX_HOOK_MARKER}(?: e\\d+)?$`),
                      `${CODEX_HOOK_MARKER} e${epoch}`,
                    ),
                  },
                ],
              },
            ],
          ]),
        ),
      });
    const older = hooksFor(FEATURE_EPOCH - 1);
    const newer = hooksFor(FEATURE_EPOCH + 1);
    const worktreeHooks = join(worktree, '.codex', 'hooks.json');
    const commonHooks = join(main, '.codex', 'hooks.json');
    writeFileSync(worktreeHooks, older);
    writeFileSync(commonHooks, newer);
    const ctx: HarnessContext = {
      worktreeRoot: worktree,
      machineConfigRoot: '/machine/.musterd',
      env: { HOME: '/home/u' },
      fs: nodeFs,
      proc: { pid: 1, startedAt: () => 's1', liveness: () => false },
      clock: { now: () => 1 },
      team: 'dawn',
    };
    const hooks = (await intentsOf(ctx)).find((intent) => intent.fragmentKey === 'hooks')!;

    await codexAdapter.apply(ctx, { kind: 'write', intent: hooks });

    expect(readFileSync(worktreeHooks, 'utf8')).toBe(older);
    expect(readFileSync(commonHooks, 'utf8')).toBe(newer);
  });

  it('emits no plugin fragments for a generalist / empty toolkit', async () => {
    const intents = await intentsOf(ctxOf(memoryFs()));
    expect(intents.filter((i) => i.fragmentKey.startsWith('plugin.'))).toEqual([]);
  });

  it('writes a project-local plugin table from the workspace toolkit and removes only that table', async () => {
    const fs = memoryFs();
    fs.writeFile(TOML, THEIR_TOML, 0o600);
    fs.writeFile(
      '/w/a/.musterd/provisioned.json',
      `${JSON.stringify({
        version: 3,
        toolkit: 'security',
        desired: ['codex'],
        contributions: {},
        provisionedAt: '2026-08-25T00:00:00.000Z',
      })}\n`,
      0o644,
    );
    fs.writeFile(
      '/w/a/.musterd/toolkits/security.json',
      `${JSON.stringify({
        toolkit: 'security',
        charter: 'own appsec evidence',
        tools: { codex_plugins: ['codex-security@openai-curated'] },
      })}\n`,
      0o644,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const plugin = intents.find((i) => i.fragmentKey === 'plugin.codex-security@openai-curated');
    expect(plugin).toBeDefined();
    expect(plugin!.containerKey).toContain('.codex/config.toml');
    expect(plugin!.payload).toEqual({
      plugin: 'codex-security@openai-curated',
      enabled: true,
    });

    expect(await codexAdapter.observe(ctx, plugin!)).toEqual({ state: 'absent' });
    await codexAdapter.apply(ctx, { kind: 'write', intent: plugin! });
    const after = fs.readFile(TOML)!;
    expect(after).toContain('[plugins."codex-security@openai-curated"]');
    expect(after).toContain('enabled = true');
    expect(after).toContain('[mcp_servers.figma]');
    expect(await codexAdapter.observe(ctx, plugin!)).toEqual({
      state: 'present',
      fingerprint: plugin!.fingerprint,
    });

    await codexAdapter.apply(ctx, { kind: 'remove', intent: plugin! });
    const removed = fs.readFile(TOML)!;
    expect(removed).not.toContain('codex-security@openai-curated');
    expect(removed).toContain('[mcp_servers.figma]');
  });
});
