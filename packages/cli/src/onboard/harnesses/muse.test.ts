import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FEATURE_EPOCH } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { memoryFs, type HarnessContext } from '../reconcile/context.js';
import {
  hasMuseHooks,
  muse,
  museAdapter,
  museHooksPath,
  museServerEntry,
  museSettingsPathFor,
  museStartCommand,
  museStopCommand,
  upsertMuseHooks,
  upsertMuseServer,
} from './muse.js';

const ENTRY = {
  command: '/usr/bin/node',
  args: ['/x/packages/mcp/dist/index.js'],
  env: { MUSTERD_SERVER: 'http://127.0.0.1:4849', MUSTERD_TEAM: 'revive' },
};

function ctxOf(worktreeRoot: string, xdg: string): HarnessContext {
  return {
    worktreeRoot,
    machineConfigRoot: '/machine/.musterd',
    env: { XDG_CONFIG_HOME: xdg },
    fs: memoryFs(),
    proc: { pid: 42, startedAt: () => 's42', liveness: () => false },
    clock: { now: () => 1_000_000 },
  };
}

describe('muse settings.json (ADR 619)', () => {
  it('creates the file with schema_version 1 and the musterd stdio server', () => {
    const { text, created } = upsertMuseServer(null, ENTRY);
    expect(created).toBe(true);
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(doc['schema_version']).toBe(1);
    expect(doc['mcpServers']).toMatchObject({
      musterd: {
        transport: 'stdio',
        command: ENTRY.command,
        enabled: true,
        // `optional`, never `required`: required wedges every non-musterd repo on the machine
        // (measured 2026-10-16 — izzo's send-back of #2697).
        mode: 'optional',
      },
    });
  });

  it('preserves every foreign key and server', () => {
    const raw = JSON.stringify({
      schema_version: 1,
      theme: 'dark',
      mcpServers: { other: { transport: 'stdio', command: 'x', args: [] } },
    });
    const { text, created } = upsertMuseServer(raw, ENTRY);
    expect(created).toBe(false);
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(doc['theme']).toBe('dark');
    expect(doc['mcpServers']).toHaveProperty('other');
    expect(doc['mcpServers']).toHaveProperty('musterd');
  });

  it('reads a legacy snake_case block and migrates our entry to camelCase', () => {
    const raw = JSON.stringify({
      mcp_servers: {
        other: { transport: 'stdio', command: 'x', args: [] },
        musterd: { transport: 'stdio', command: 'old', args: [], mode: 'required' },
      },
    });
    const { text } = upsertMuseServer(raw, ENTRY);
    const doc = JSON.parse(text) as Record<string, Record<string, unknown>>;
    expect(doc['mcpServers']).toHaveProperty('musterd');
    expect(doc['mcpServers']['musterd']).toMatchObject({ mode: 'optional' });
    // Foreign servers migrate to camelCase with ours; the snake key is dropped entirely
    // so mcpServers and mcp_servers never coexist (muse faults on both).
    expect(doc['mcpServers']).toHaveProperty('other');
    expect(doc['mcp_servers']).toBeUndefined();
  });

  it('refuses a malformed file instead of clobbering it', () => {
    expect(() => upsertMuseServer('{not json', ENTRY)).toThrow(/does not parse/);
  });

  it('the server entry carries the launch-surface marker', () => {
    expect(museServerEntry(ENTRY).env).toMatchObject({ MUSTERD_SERVER: 'http://127.0.0.1:4849' });
    expect(Object.keys(museServerEntry(ENTRY).env).some((k) => k.includes('SURFACE'))).toBe(true);
  });

  // Regression: stanley's decline on lane 01M50ZJ7B3 (#2710) — muse faults when
  // settings.json carries both mcpServers and mcp_servers. The snake key is now
  // dropped entirely (foreign servers migrate to camelCase) so they never coexist.
  it('legacy snake block + fresh upsert drops mcp_servers entirely', () => {
    const raw = JSON.stringify({
      mcp_servers: {
        other: { transport: 'stdio', command: 'x', args: [] },
        musterd: { transport: 'stdio', command: 'old', args: [], mode: 'required' },
      },
    });
    const { text } = upsertMuseServer(raw, ENTRY);
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(doc['mcpServers']).toBeDefined();
    expect(doc['mcp_servers']).toBeUndefined();
    expect(doc['mcpServers'] as Record<string, unknown>).toHaveProperty('musterd');
    expect(doc['mcpServers'] as Record<string, unknown>).toHaveProperty('other');
  });

  it('existing camel block keeps foreign servers and drops any stray snake key', () => {
    const raw = JSON.stringify({
      mcpServers: { foreign: { transport: 'stdio', command: 'y', args: [] } },
      mcp_servers: { musterd: { transport: 'stdio', command: 'old', args: [] } },
    });
    const { text } = upsertMuseServer(raw, ENTRY);
    const doc = JSON.parse(text) as Record<string, unknown>;
    expect(doc['mcp_servers']).toBeUndefined();
    expect(doc['mcpServers'] as Record<string, unknown>).toHaveProperty('foreign');
    expect(doc['mcpServers'] as Record<string, unknown>).toHaveProperty('musterd');
  });
});

describe('muse hooks.json (ADR 619 — measured nesting)', () => {
  it('writes SessionStart + Stop in the shape the binary accepts', () => {
    const doc = JSON.parse(upsertMuseHooks(null)) as {
      hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
    };
    expect(Object.keys(doc.hooks).sort()).toEqual(['SessionStart', 'Stop']);
    for (const groups of Object.values(doc.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]!.hooks[0]).toMatchObject({ type: 'command' });
    }
  });

  it('preserves foreign events and groups, and re-upsert stays at one musterd group', () => {
    const raw = JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'lint' }] }] },
    });
    const once = upsertMuseHooks(raw);
    const twice = upsertMuseHooks(once);
    const doc = JSON.parse(twice) as { hooks: Record<string, unknown[]> };
    expect(doc.hooks['PreToolUse']).toHaveLength(1);
    expect(doc.hooks['SessionStart']).toHaveLength(1);
    expect(doc.hooks['Stop']).toHaveLength(1);
    expect(hasMuseHooks(twice)).toBe(true);
  });

  it('refuses a malformed file instead of clobbering it', () => {
    expect(() => upsertMuseHooks('{not json')).toThrow(/does not parse/);
    expect(hasMuseHooks('{not json')).toBe(false);
    expect(hasMuseHooks(null)).toBe(false);
  });

  it('a stale epoch reads as absent', () => {
    const stale = upsertMuseHooks(null).replaceAll(`e${FEATURE_EPOCH}`, 'e0');
    expect(hasMuseHooks(stale)).toBe(false);
  });

  it('commands carry the epoch markers and the muse hook name', () => {
    expect(museStartCommand()).toMatch(/musterd-muse-start e\d+/);
    expect(museStopCommand()).toMatch(/--hook muse/);
    expect(museStopCommand()).toMatch(/musterd-muse-stop e\d+/);
  });
});

describe('museAdapter fragments', () => {
  it('desires the machine settings fragment and the folder hooks fragment', async () => {
    const ctx = ctxOf('/w/a', '/xdg');
    const intents = await museAdapter.desiredFragments(ctx, await museAdapter.target(ctx));
    expect(intents.map((i) => i.fragmentKey).sort()).toEqual(['hooks.musterd', 'mcp.musterd']);
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect(mcp.scope).toBe('machine');
    expect(mcp.resourceKey).toContain('muse');
    const hooks = intents.find((i) => i.fragmentKey === 'hooks.musterd')!;
    expect(hooks.scope).toBe('folder');
  });

  it('apply write → observe present; remove → absent (both fragments)', async () => {
    const ctx = ctxOf('/w/a', '/xdg');
    const intents = await museAdapter.desiredFragments(ctx, await museAdapter.target(ctx));
    for (const intent of intents) {
      await museAdapter.apply(ctx, { kind: 'write', intent });
      const seen = await museAdapter.observe(ctx, intent);
      expect(seen).toMatchObject({ state: 'present', fingerprint: intent.fingerprint });
      await museAdapter.apply(ctx, { kind: 'remove', intent });
      expect(await museAdapter.observe(ctx, intent)).toMatchObject({ state: 'absent' });
    }
  });

  it('a malformed settings.json reads invalid-container, never absent', async () => {
    const ctx = ctxOf('/w/a', '/xdg');
    const path = museSettingsPathFor(ctx.env);
    ctx.fs.mkdirp('/xdg/muse');
    ctx.fs.writeFile(path, '{not json', 0o600);
    const intents = await museAdapter.desiredFragments(ctx, await museAdapter.target(ctx));
    const mcp = intents.find((i) => i.fragmentKey === 'mcp.musterd')!;
    expect(await museAdapter.observe(ctx, mcp)).toMatchObject({ state: 'invalid-container' });
  });

  it('unknown fragments are refused by name', async () => {
    const ctx = ctxOf('/w/a', '/xdg');
    const intents = await museAdapter.desiredFragments(ctx, await museAdapter.target(ctx));
    await expect(
      museAdapter.apply(ctx, {
        kind: 'write',
        intent: { ...intents[0]!, fragmentKey: 'nope' },
      }),
    ).rejects.toThrow(/unknown muse fragment/);
    expect(await museAdapter.observe(ctx, { ...intents[0]!, fragmentKey: 'nope' })).toMatchObject({
      state: 'absent',
    });
  });

  it('interactive launch resolves and resumes in muse verbs', () => {
    expect(museAdapter.interactive!.fresh()).toEqual([]);
    expect(museAdapter.interactive!.resume('abc')).toEqual(['resume', 'abc']);
    expect(museAdapter.interactive!.resume(undefined)).toEqual(['resume', '--last']);
    expect(museAdapter.interactive!.installHint).toMatch(/dev\.meta\.ai/);
  });
});

describe('muse Harness detect/configure (hermetic HOME + cwd)', () => {
  let dir: string;
  let prevCwd: string;
  let prevHome: string | undefined;
  let prevXdg: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'muse-harness-test-'));
    prevCwd = process.cwd();
    process.chdir(dir);
    prevHome = process.env['HOME'];
    prevXdg = process.env['XDG_CONFIG_HOME'];
    process.env['HOME'] = dir;
    delete process.env['XDG_CONFIG_HOME'];
  });
  afterEach(() => {
    process.chdir(prevCwd);
    if (prevHome === undefined) delete process.env['HOME'];
    else process.env['HOME'] = prevHome;
    if (prevXdg === undefined) delete process.env['XDG_CONFIG_HOME'];
    else process.env['XDG_CONFIG_HOME'] = prevXdg;
    rmSync(dir, { recursive: true, force: true });
  });

  it('uninstalled and unconfigured reads honestly', async () => {
    const d = await muse.detect();
    expect(d.configured).toBe(false);
  });

  it('configure writes settings + hooks, detect reads them back configured', async () => {
    const res = await muse.configure(ENTRY);
    expect(res.target).toBe(join(dir, '.config', 'muse', 'settings.json'));
    const d = await muse.detect();
    expect(d.configured).toBe(true);
    expect(hasMuseHooks(readFileSync(museHooksPath(dir), 'utf8'))).toBe(true);
  });
});
