import { describe, expect, it } from 'vitest';
import { FLOOR_DENIED_SKILLS } from '../permissions.js';
import { memoryFs, type HarnessContext, type MemoryFs } from '../reconcile/context.js';
import { emptyDeclaredSet } from '../seatTools/resolve.js';
import { opencodeAdapter } from './opencode.js';
import {
  OPENCODE_PLUGIN_GENERATION,
  OPENCODE_PLUGIN_SURFACE,
  opencodePluginHeader,
  renderOpencodePlugin,
} from './opencodePlugin.js';

const ROOT = '/w/a';
const CFG = '/w/a/.opencode/opencode.json';
const PLUGIN = '/w/a/.opencode/plugins/musterd.js';

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
  return opencodeAdapter.desiredFragments(ctx, await opencodeAdapter.target(ctx));
}

const THEIR_CFG = JSON.stringify({
  theme: 'ayu',
  mcp: { context7: { type: 'local', command: ['npx', 'context7'] } },
});

describe('opencodeAdapter — managed fragments', () => {
  it('exposes the musterd MCP entry and the doorbell plugin as independent fragments', async () => {
    const intents = await intentsOf(ctxOf(memoryFs()));
    expect(intents.map((i) => i.fragmentKey)).toEqual(['mcp.musterd', 'plugin']);
    expect(new Set(intents.map((i) => i.containerKey)).size).toBe(2);
    const payload = intents[0]!.payload as { environment: Record<string, string>; type: string };
    expect(payload.type).toBe('local');
    expect(payload.environment).toEqual({ MUSTERD_LAUNCH_SURFACE: 'opencode' });
    expect(intents[1]!.payload).toBe(renderOpencodePlugin());
  });

  it('writes, observes, and removes the doorbell plugin fragment; leaves foreign or newer plugins untouched', async () => {
    const fs = memoryFs();
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const plugin = intents.find((i) => i.fragmentKey === 'plugin')!;
    expect(await opencodeAdapter.observe(ctx, plugin)).toEqual({ state: 'absent' });

    await opencodeAdapter.apply(ctx, { kind: 'write', intent: plugin });
    expect(fs.readFile(PLUGIN)).toBe(renderOpencodePlugin());
    expect(await opencodeAdapter.observe(ctx, plugin)).toEqual({
      state: 'present',
      fingerprint: plugin.fingerprint,
    });

    await opencodeAdapter.apply(ctx, { kind: 'remove', intent: plugin });
    expect(fs.readFile(PLUGIN)).toBeNull();
    expect(await opencodeAdapter.observe(ctx, plugin)).toEqual({ state: 'absent' });

    // A newer generation is not downgraded on apply (ADR 168).
    const newer = `${opencodePluginHeader(OPENCODE_PLUGIN_GENERATION + 1)}\nexport default {};\n`;
    fs.writeFile(PLUGIN, newer, 0o644);
    await opencodeAdapter.apply(ctx, { kind: 'write', intent: plugin });
    expect(fs.readFile(PLUGIN)).toBe(newer);

    // A foreign file at the path is neither overwritten nor removed (ADR 027).
    const foreign = '// user plugin\nexport default {};\n';
    fs.writeFile(PLUGIN, foreign, 0o644);
    await opencodeAdapter.apply(ctx, { kind: 'write', intent: plugin });
    expect(fs.readFile(PLUGIN)).toBe(foreign);
    await opencodeAdapter.apply(ctx, { kind: 'remove', intent: plugin });
    expect(fs.readFile(PLUGIN)).toBe(foreign);
  });

  it('omits the plugin fragment when opencode:plugin is declined in .musterd/declined.json (ADR 332)', async () => {
    const fs = memoryFs();
    fs.writeFile(
      `${ROOT}/.musterd/declined.json`,
      JSON.stringify({
        version: 1,
        declined: [{ surface: OPENCODE_PLUGIN_SURFACE, at: '2026-09-06T00:00:00Z' }],
      }),
      0o600,
    );
    const intents = await intentsOf(ctxOf(fs));
    expect(intents.map((i) => i.fragmentKey)).toEqual(['mcp.musterd']);
  });

  it('unrelated keys and entries survive the write and the remove byte-for-key intact', async () => {
    const fs = memoryFs();
    fs.writeFile(CFG, THEIR_CFG, 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents[0]!;
    expect(await opencodeAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });

    await opencodeAdapter.apply(ctx, { kind: 'write', intent: mcp });
    const after = JSON.parse(fs.readFile(CFG)!) as {
      theme?: string;
      mcp: Record<string, unknown>;
    };
    expect(after.theme).toBe('ayu'); // their unknown top-level key untouched
    expect(after.mcp['context7']).toBeDefined(); // their other server untouched
    expect(await opencodeAdapter.observe(ctx, mcp)).toEqual({
      state: 'present',
      fingerprint: mcp.fingerprint,
    });

    await opencodeAdapter.apply(ctx, { kind: 'remove', intent: mcp });
    const removed = JSON.parse(fs.readFile(CFG)!) as {
      theme?: string;
      mcp?: Record<string, unknown>;
    };
    expect(removed.theme).toBe('ayu');
    expect(removed.mcp?.['musterd']).toBeUndefined();
    expect(await opencodeAdapter.observe(ctx, mcp)).toEqual({ state: 'absent' });
  });

  it('an unparseable container observes invalid-container — nothing in it may be touched', async () => {
    const fs = memoryFs();
    fs.writeFile(CFG, '{ not json', 0o600);
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    expect(await opencodeAdapter.observe(ctx, intents[0]!)).toMatchObject({
      state: 'invalid-container',
    });
    await expect(
      opencodeAdapter.apply(ctx, { kind: 'write', intent: intents[0]! }),
    ).rejects.toThrow(/invalid at apply time/);
    expect(fs.readFile(CFG)).toBe('{ not json'); // prior bytes stay untouched
  });

  it('a musterd entry carrying MUSTERD_SURFACE observes as legacy-launch-marker; repair swaps only the marker', async () => {
    const fs = memoryFs();
    fs.writeFile(
      CFG,
      JSON.stringify({
        mcp: {
          musterd: {
            type: 'local',
            command: ['/their/node', '/their/adapter.js'],
            environment: { MUSTERD_SURFACE: 'opencode', MUSTERD_GRANT: 'msgr_keep' },
          },
        },
      }),
      0o600,
    );
    const ctx = ctxOf(fs);
    const intents = await intentsOf(ctx);
    const mcp = intents[0]!;
    expect((await opencodeAdapter.observe(ctx, mcp)).state).toBe('legacy-launch-marker');

    await opencodeAdapter.apply(ctx, { kind: 'repair-launch-marker', intent: mcp });
    const after = JSON.parse(fs.readFile(CFG)!) as {
      mcp: Record<string, { command: string[]; environment: Record<string, string> }>;
    };
    const entry = after.mcp['musterd'];
    expect(entry.environment.MUSTERD_LAUNCH_SURFACE).toBe('opencode');
    expect(entry.environment.MUSTERD_SURFACE).toBeUndefined();
    expect(entry.environment.MUSTERD_GRANT).toBe('msgr_keep'); // unrelated env preserved
    expect(entry.command).toEqual(['/their/node', '/their/adapter.js']); // repaired, not adopted
  });

  it('opencode closes an undeclared plugins', async () => {
    const fs = memoryFs();
    fs.writeFile(CFG, THEIR_CFG, 0o600);
    const ctx: HarnessContext = { ...ctxOf(fs), seatTools: emptyDeclaredSet() };
    const intents = await intentsOf(ctx);
    expect(intents.map((i) => i.fragmentKey)).toEqual(['mcp.musterd', 'plugin', 'seatTools']);
    const seat = intents.find((i) => i.fragmentKey === 'seatTools')!;
    const payload = seat.payload as {
      plugin: Record<string, string>;
      skill: Record<string, string>;
      mcp: Record<string, string>;
    };
    expect(payload.plugin).toEqual({ '*': 'deny' });

    await opencodeAdapter.apply(ctx, { kind: 'write', intent: seat });
    const after = JSON.parse(fs.readFile(CFG)!) as {
      theme: string;
      mcp: Record<string, unknown>;
      permission: { plugin: Record<string, string> };
    };
    expect(after.theme).toBe('ayu');
    expect(after.mcp['context7']).toBeDefined();
    expect(after.permission.plugin).toEqual({ '*': 'deny' });
    expect(await opencodeAdapter.observe(ctx, seat)).toEqual({
      state: 'present',
      fingerprint: seat.fingerprint,
    });

    await opencodeAdapter.apply(ctx, { kind: 'remove', intent: seat });
    const removed = JSON.parse(fs.readFile(CFG)!) as {
      theme: string;
      mcp: Record<string, unknown>;
      permission?: unknown;
    };
    expect(removed.theme).toBe('ayu');
    expect(removed.mcp['context7']).toBeDefined();
    expect(removed.permission).toBeUndefined();
  });

  it('opencode closes an undeclared skills', async () => {
    const ctx: HarnessContext = {
      ...ctxOf(memoryFs()),
      seatTools: { ...emptyDeclaredSet(), skills: ['review'] },
    };
    const seat = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'seatTools')!;
    const skill = (seat.payload as { skill: Record<string, string> }).skill;
    expect(skill['*']).toBe('deny');
    expect(skill['review']).toBe('allow');
    expect(skill['Skill(review)']).toBeUndefined();
  });

  it('opencode closes an undeclared mcp_servers', async () => {
    const ctx: HarnessContext = {
      ...ctxOf(memoryFs()),
      seatTools: { ...emptyDeclaredSet(), mcp_servers: ['context7'] },
    };
    const seat = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'seatTools')!;
    expect((seat.payload as { mcp: Record<string, string> }).mcp).toEqual({
      '*': 'deny',
      musterd: 'allow',
      context7: 'allow',
    });
  });

  it('opencode denies both floor skills', async () => {
    const ctx: HarnessContext = {
      ...ctxOf(memoryFs()),
      seatTools: { ...emptyDeclaredSet(), skills: [...FLOOR_DENIED_SKILLS, 'review'] },
    };
    const seat = (await intentsOf(ctx)).find((i) => i.fragmentKey === 'seatTools')!;
    const skill = (seat.payload as { skill: Record<string, string> }).skill;
    expect(skill['review']).toBe('allow');
    for (const name of FLOOR_DENIED_SKILLS) expect(skill[name]).toBe('deny');
    expect(Object.keys(skill).filter((k) => k.startsWith('Skill('))).toEqual([]);
  });

  it('a jsonc sibling skips the seatTools fragment', async () => {
    const fs = memoryFs();
    fs.writeFile(`${ROOT}/.opencode/opencode.jsonc`, '{}\n', 0o644);
    const ctx: HarnessContext = { ...ctxOf(fs), seatTools: emptyDeclaredSet() };
    expect((await intentsOf(ctx)).map((i) => i.fragmentKey)).toEqual(['mcp.musterd', 'plugin']);
  });
});
