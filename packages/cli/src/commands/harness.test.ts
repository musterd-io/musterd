import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { loadProvisioning } from '../onboard/manifest.js';
import { nodeFs, type HarnessContext } from '../onboard/reconcile/context.js';
import {
  canonicalFingerprint,
  folderResourceKey,
  type FragmentMutation,
  type HarnessAdapter,
  type ObservedFragment,
} from '../onboard/reconcile/fragments.js';
import { CLAUDE_BRIDGE, roleSkillFragments } from '../onboard/roleSkills.js';
import { deltaLine, harnessCommand, missingBlock, selectableHarnesses } from './harness.js';

let cwd: string;
let machineRoot: string;
const cwd0 = process.cwd();

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'musterd-harness-'));
  machineRoot = mkdtempSync(join(tmpdir(), 'musterd-harness-machine-'));
  vi.spyOn(process, 'cwd').mockReturnValue(cwd);
});
afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(cwd0);
  rmSync(cwd, { recursive: true, force: true });
  rmSync(machineRoot, { recursive: true, force: true });
});

/** One scriptable external adapter with a single folder fragment, physical state in-memory. */
function fakeAdapter(
  id: string,
  opts: { available?: boolean; observed?: ObservedFragment } = {},
): HarnessAdapter & { state: { observed: ObservedFragment; applied: FragmentMutation[] } } {
  const state = {
    observed: opts.observed ?? ({ state: 'absent' } as ObservedFragment),
    applied: [] as FragmentMutation[],
  };
  const payload = { entry: id };
  return {
    state,
    id,
    surface: 'other',
    adapterVersion: 1,
    availability: async () => ({
      available: opts.available ?? true,
      detail: opts.available === false ? 'not installed here' : 'ok',
    }),
    target: async (ctx) => ({
      containers: [
        { containerKey: `folder ${ctx.worktreeRoot} ${id}`, scope: 'folder', handle: null },
      ],
    }),
    desiredFragments: async (ctx) => [
      {
        harness: id,
        resourceKey: folderResourceKey(ctx.worktreeRoot, id, 'entry'),
        containerKey: `folder ${ctx.worktreeRoot} ${id}`,
        fragmentKey: 'entry',
        scope: 'folder',
        fingerprint: canonicalFingerprint(payload),
        payload,
      },
    ],
    observe: async () => state.observed,
    apply: async (_ctx, mutation) => {
      state.applied.push(mutation);
      state.observed =
        mutation.kind === 'remove'
          ? { state: 'absent' }
          : { state: 'present', fingerprint: mutation.intent.fingerprint };
    },
  };
}

function ctxOf(): HarnessContext {
  return {
    worktreeRoot: cwd,
    machineConfigRoot: machineRoot,
    env: {},
    fs: nodeFs,
    proc: { pid: process.pid, startedAt: () => 's-test', liveness: () => false },
    clock: { now: () => Date.now() },
    team: 'dawn',
  };
}

function writeV2Identity(): void {
  mkdirSync(join(cwd, '.musterd'), { recursive: true });
  writeFileSync(
    join(cwd, '.musterd', 'workspace.json'),
    JSON.stringify({
      version: 2,
      server: 'http://localhost:4849',
      team: 'dawn',
      claim: { mode: 'seat', name: 'Ada' },
    }),
  );
}

function writeV1Identity(): void {
  mkdirSync(join(cwd, '.musterd'), { recursive: true });
  writeFileSync(
    join(cwd, '.musterd', 'workspace.json'),
    JSON.stringify({
      server: 'http://localhost:4849',
      team: 'dawn',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'Ada' },
    }),
  );
  writeFileSync(
    join(cwd, '.musterd', 'binding.json'),
    JSON.stringify({
      server: 'http://localhost:4849',
      team: 'dawn',
      surface: 'claude-code',
      agent_key: 'mskey_x',
      claim: { mode: 'seat', name: 'Ada' },
      model: 'claude-fable-5',
    }),
  );
  writeFileSync(
    join(cwd, '.musterd', 'provisioned.json'),
    JSON.stringify({
      version: 1,
      role: 'backend',
      harness: 'fake-a',
      mcpServers: ['musterd'],
      permissions: { allow: [], ask: [], deny: [] },
      provisionedAt: '2026-08-01T00:00:00.000Z',
    }),
  );
}

function writeV2Provisioning(
  desired: string[],
  contributions: Record<string, string[]> = {},
  profile = '',
): void {
  mkdirSync(join(cwd, '.musterd'), { recursive: true });
  writeFileSync(
    join(cwd, '.musterd', 'provisioned.json'),
    JSON.stringify({
      version: 2,
      profile,
      desired,
      contributions,
      provisionedAt: '2026-08-19T00:00:00.000Z',
    }),
  );
}

function writeV3Provisioning(
  desired: string[],
  contributions: Record<string, string[]> = {},
  toolkit = '',
): void {
  mkdirSync(join(cwd, '.musterd'), { recursive: true });
  writeFileSync(
    join(cwd, '.musterd', 'provisioned.json'),
    JSON.stringify({
      version: 3,
      toolkit,
      desired,
      contributions,
      provisionedAt: '2026-08-19T00:00:00.000Z',
    }),
  );
}

async function run(argv: string[], deps: Parameters<typeof harnessCommand>[1]) {
  const lines: string[] = [];
  const code = await harnessCommand(parseArgs(argv), {
    ...deps,
    out: (line) => lines.push(line),
  });
  return { code, out: lines.join('\n') };
}

describe('musterd harness configure', () => {
  it('saves desire FIRST, reconciles with legacyRepair, and reports per-fragment results', async () => {
    writeV2Identity();
    const a = fakeAdapter('fake-a');
    const b = fakeAdapter('fake-b');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a, b],
      select: ['fake-a'],
    });
    expect(code).toBe(0);
    expect(out).toContain('desired harnesses: fake-a');
    expect(out).toContain('fake-a (entry)  (create) ✓ applied');
    expect(out).toContain('worktree configured');
    expect(a.state.applied[0]?.kind).toBe('write');
    expect(b.state.applied).toEqual([]);
    const prov = loadProvisioning(cwd);
    expect(prov.kind === 'valid' && prov.value.desired).toEqual(['fake-a']);
  });

  it('surfaces the fragment key, conflict detail, and status hint when a fragment conflicts', async () => {
    writeV2Identity();
    const a = fakeAdapter('fake-a', {
      observed: { state: 'present', fingerprint: 'f'.repeat(64) },
    });
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
    });
    expect(code).toBe(1);
    expect(out).toContain("fake-a (entry)  ✗ conflict — not musterd's to overwrite");
    expect(out).toContain('musterd harness status');
    expect(out).not.toContain('worktree configured');
  });

  it('echoes the delta against the prior set, so an Enter that toggled nothing is visible', async () => {
    writeV2Identity();
    writeV3Provisioning(['fake-a']);
    const registry = [fakeAdapter('fake-a'), fakeAdapter('fake-b')];
    const same = await run(['configure'], { ctx: ctxOf(), registry, select: ['fake-a'] });
    expect(same.out).toContain('no change from the previous set');
    const swapped = await run(['configure'], { ctx: ctxOf(), registry, select: ['fake-b'] });
    expect(swapped.out).toContain('added fake-b · removed fake-a');
  });

  it('deltaLine names additions before removals', () => {
    expect(deltaLine(['a', 'b'], ['a', 'b'])).toBe('no change from the previous set');
    expect(deltaLine(['a'], ['a', 'grok'])).toBe('added grok');
    expect(deltaLine(['a', 'b'], ['a'])).toBe('removed b');
  });

  it('an empty set is valid — everything owned is released', async () => {
    writeV2Identity();
    writeV3Provisioning([]);
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: [],
    });
    expect(code).toBe(0);
    expect(out).toContain('desired harnesses: (none)');
  });

  it('converts a recognized version-1 worktree only after confirmation, retaining role as toolkit', async () => {
    writeV1Identity();
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
      confirm: true,
    });
    expect(code).toBe(0);
    expect(out).toContain('converted the legacy identity/manifest to the current format');
    const spec = JSON.parse(readFileSync(join(cwd, '.musterd', 'workspace.json'), 'utf8'));
    expect(spec.version).toBe(2);
    expect(spec.surface).toBeUndefined();
    const binding = JSON.parse(readFileSync(join(cwd, '.musterd', 'binding.json'), 'utf8'));
    expect(binding.version).toBe(2);
    expect(binding.surface).toBeUndefined();
    expect(binding.model).toBe('claude-fable-5'); // runtime fields carried through
    const prov = loadProvisioning(cwd);
    expect(prov.kind === 'valid' && prov.value.toolkit).toBe('backend');
    // v1 name-only records never became evidence: the recorded contribution is the FRESH one the
    // reconciler just created and journaled (the physical fragment was re-observed absent, then
    // written) — not a carried-over v1 mcpServers list.
    expect(prov.kind === 'valid' && Object.keys(prov.value.contributions)).toEqual(['fake-a']);
    expect(a.state.applied[0]?.kind).toBe('write');
  });

  it('converts a version-2 manifest only after confirmation, carrying profile across as toolkit (ADR 296)', async () => {
    writeV2Identity();
    writeV2Provisioning(['fake-a'], {}, 'backend');
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
      confirm: true,
    });
    expect(code).toBe(0);
    expect(out).toContain('converted the legacy identity/manifest to the current format');
    const raw = JSON.parse(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8'));
    expect(raw.version).toBe(3);
    expect(raw.toolkit).toBe('backend');
    expect(raw.profile).toBeUndefined();
    const prov = loadProvisioning(cwd);
    expect(prov.kind === 'valid' && prov.value.toolkit).toBe('backend');
  });

  it('a declined v2-manifest conversion writes NOTHING and exits 0', async () => {
    writeV2Identity();
    writeV2Provisioning(['fake-a'], {}, 'backend');
    const before = readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8');
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
      confirm: false,
    });
    expect(code).toBe(0);
    expect(out).toContain('no changes made');
    expect(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8')).toBe(before);
    expect(a.state.applied).toEqual([]);
  });

  it('a declined conversion writes NOTHING and exits 0', async () => {
    writeV1Identity();
    const before = readFileSync(join(cwd, '.musterd', 'workspace.json'), 'utf8');
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
      confirm: false,
    });
    expect(code).toBe(0);
    expect(out).toContain('no changes made');
    expect(readFileSync(join(cwd, '.musterd', 'workspace.json'), 'utf8')).toBe(before);
    expect(a.state.applied).toEqual([]);
  });

  it('refuses to newly select a harness that is not installed here, and writes nothing (ADR 643)', async () => {
    writeV2Identity();
    writeV3Provisioning([]);
    const before = readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8');
    const a = fakeAdapter('fake-a', { available: false });
    await expect(
      run(['configure'], { ctx: ctxOf(), registry: [a], select: ['fake-a'] }),
    ).rejects.toThrow(/not installed here: fake-a .*install it/s);
    expect(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8')).toBe(before);
    expect(a.state.applied).toEqual([]);
  });

  it('an already-selected unavailable harness stays pending and still exits 0', async () => {
    writeV2Identity();
    writeV3Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a', { available: false });
    const { code, out } = await run(['configure'], {
      ctx: ctxOf(),
      registry: [a],
      select: ['fake-a'],
    });
    expect(code).toBe(0);
    expect(out).toContain('pending');
    expect(a.state.applied).toEqual([]);
  });

  it('the picker offers installed harnesses and already-selected ones, and names the rest', () => {
    const avail = new Map([
      ['fake-a', { available: true }],
      ['fake-b', { available: false }],
      ['fake-c', { available: false }],
    ]);
    const registry = [fakeAdapter('fake-a'), fakeAdapter('fake-b'), fakeAdapter('fake-c')];
    const { offered, missing } = selectableHarnesses(registry, avail, ['fake-c']);
    expect(offered.map((a) => a.id)).toEqual(['fake-a', 'fake-c']);
    expect(missing.map((a) => a.id)).toEqual(['fake-b']);
  });

  it('names each missing harness on its own row with its install command (ADR 643 §1)', () => {
    const withHint = {
      ...fakeAdapter('muse'),
      interactive: {
        resolveBin: async () => null,
        installHint: 'curl -fsSL https://dev.meta.ai/install.sh | bash',
        fresh: () => [],
        resume: () => [],
      },
    };
    const lines = stripVTControlCharacters(missingBlock([withHint, fakeAdapter('fake-b')])).split(
      '\n',
    );
    expect(lines[0]).toMatch(/not installed here .*musterd harness configure/);
    expect(lines[1]).toBe('  muse    curl -fsSL https://dev.meta.ai/install.sh | bash');
    expect(lines[2]).toBe('  fake-b  no install command known');
  });

  it('the headless refusal carries the install command', async () => {
    writeV2Identity();
    writeV3Provisioning([]);
    const a = {
      ...fakeAdapter('fake-a', { available: false }),
      interactive: {
        resolveBin: async () => null,
        installHint: 'npm install -g fake-a',
        fresh: () => [],
        resume: () => [],
      },
    };
    await expect(
      run(['configure'], { ctx: ctxOf(), registry: [a], select: ['fake-a'] }),
    ).rejects.toThrow(/install: npm install -g fake-a/);
  });

  it('refuses a folder with no musterd identity at all', async () => {
    await expect(
      run(['configure'], { ctx: ctxOf(), registry: [fakeAdapter('fake-a')], select: [] }),
    ).rejects.toThrow(/musterd init/);
  });
});

describe('musterd harness status', () => {
  it('reports missing selection with the configure repair and exits 1', async () => {
    writeV2Identity();
    const { code, out } = await run(['status'], {
      ctx: ctxOf(),
      registry: [fakeAdapter('fake-a')],
    });
    expect(code).toBe(1);
    expect(out).toContain('no harness selection here');
    expect(out).toContain('musterd harness configure');
  });

  it('reports a version-1 worktree as legacy with the configure repair', async () => {
    writeV1Identity();
    const { code, out } = await run(['status'], {
      ctx: ctxOf(),
      registry: [fakeAdapter('fake-a')],
    });
    expect(code).toBe(1);
    expect(out).toContain('pre-ADR-281');
  });

  it('reports a version-2 manifest as legacy WITHOUT misnaming it a version-1 identity', async () => {
    writeV2Identity();
    writeV2Provisioning(['fake-a']);
    const { code, out } = await run(['status'], {
      ctx: ctxOf(),
      registry: [fakeAdapter('fake-a')],
    });
    expect(code).toBe(1);
    expect(out).toContain('older provisioning manifest');
    expect(out).toContain('musterd harness configure');
    expect(out).not.toContain('pre-ADR-281');
  });

  it('exit 0 only when every desired fragment is usable — a needed create exits 1', async () => {
    writeV2Identity();
    writeV3Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a'); // fragment absent → needs wire
    const first = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(first.code).toBe(1);
    expect(first.out).toContain('→ needs wire');

    // Configure it into place, then status is healthy.
    await run(['configure'], { ctx: ctxOf(), registry: [a], select: ['fake-a'] });
    const second = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(second.code).toBe(0);
    expect(second.out).toContain('✓ in place');
    expect(second.out).toContain('selected · available');
  });

  it('pending unavailability exits zero — the selection survives the harness not being installed', async () => {
    writeV2Identity();
    writeV3Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a', { available: false });
    const { code, out } = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(0);
    expect(out).toContain('pending (not installed here)');
  });

  it('a pre-ADR-286 registration reports its repair and exits 1', async () => {
    writeV2Identity();
    writeV3Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a', {
      observed: { state: 'legacy-launch-marker', fingerprint: 'l'.repeat(64) },
    });
    const { code, out } = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(1);
    expect(out).toContain('pre-ADR-286 registration — run musterd harness configure');
  });

  it('an undesired owned contribution that is not yet released exits 1', async () => {
    writeV2Identity();
    // fake-a was configured, then deselected — the ledger still names this worktree.
    const a = fakeAdapter('fake-a');
    await run(['configure'], { ctx: ctxOf(), registry: [a], select: ['fake-a'] });
    writeV3Provisioning(
      [],
      JSON.parse(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8')).contributions,
    );
    const { code, out } = await run(['status'], { ctx: ctxOf(), registry: [a] });
    expect(code).toBe(1);
    expect(out).toContain('not selected');
  });

  it('a seat with a role and no bridge shows role-skill.<skill> as needs wire', async () => {
    const home = mkdtempSync(join(tmpdir(), 'musterd-harness-roster-'));
    const prevConfig = process.env['MUSTERD_CONFIG'];
    process.env['MUSTERD_CONFIG'] = join(machineRoot, 'config.json');
    try {
      writeFileSync(
        join(machineRoot, 'config.json'),
        JSON.stringify({ rosterHome: { alpha: home } }),
      );
      mkdirSync(join(home, '.musterd', 'seats'), { recursive: true });
      writeFileSync(
        join(home, '.musterd', 'seats', 'slippy.toml'),
        'kind = "agent"\nrole = "designer"\n',
      );
      mkdirSync(join(cwd, '.agents', 'skills', 'designer'), { recursive: true });
      writeFileSync(
        join(cwd, '.agents', 'skills', 'designer', 'SKILL.md'),
        '---\nname: designer\ndescription: Owns what people see.\n---\n\n# designer\n',
      );
      mkdirSync(join(cwd, '.musterd'), { recursive: true });
      writeFileSync(
        join(cwd, '.musterd', 'workspace.json'),
        JSON.stringify({
          version: 2,
          server: 'http://localhost:4849',
          team: 'alpha',
          claim: { mode: 'seat', name: 'slippy' },
        }),
      );
      writeFileSync(
        join(cwd, '.musterd', 'binding.json'),
        JSON.stringify({
          version: 2,
          server: 'http://localhost:4849',
          team: 'alpha',
          claim: { mode: 'seat', name: 'slippy' },
        }),
      );
      writeV3Provisioning(['claude-code']);
      const a = fakeAdapter('claude-code');
      const entry = a.desiredFragments.bind(a);
      a.desiredFragments = async (ctx) => [
        ...(await entry(ctx)),
        ...roleSkillFragments(
          ctx,
          'claude-code',
          CLAUDE_BRIDGE,
          `folder ${ctx.worktreeRoot} claude-code-role-skills`,
        ),
      ];
      a.observe = async (_ctx, intent) =>
        intent.fragmentKey.startsWith('role-skill.')
          ? { state: 'absent' }
          : { state: 'present', fingerprint: intent.fingerprint };
      // No injected ctx: status must resolve the seat's skills itself.
      const { code, out } = await run(['status'], { registry: [a] });
      expect(code).toBe(1);
      expect(out).toContain('role-skill.designer');
      expect(out).toMatch(/role-skill\.designer\s+folder\s+→ needs wire/);
    } finally {
      if (prevConfig === undefined) delete process.env['MUSTERD_CONFIG'];
      else process.env['MUSTERD_CONFIG'] = prevConfig;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('--json exposes the same stable fields', async () => {
    writeV2Identity();
    writeV3Provisioning(['fake-a']);
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['status', '--json'], {
      ctx: ctxOf(),
      registry: [a],
    });
    expect(code).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.desired).toEqual(['fake-a']);
    const fakeA = parsed.harnesses.find((h: { harness: string }) => h.harness === 'fake-a');
    expect(fakeA.fragments[0]).toMatchObject({
      fragmentKey: 'entry',
      resourceKey: expect.stringContaining('folder'),
      scope: 'folder',
      desired: true,
      observation: 'absent',
      plan: 'create',
      journal: 'none',
      lock: 'free',
    });
  });
});

describe('musterd harness configure --select --yes (the headless form)', () => {
  it('converts a pre-ADR-281 worktree non-interactively — the flags ARE the confirmation', async () => {
    writeV1Identity();
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure', '--select', 'fake-a', '--yes'], {
      ctx: ctxOf(),
      registry: [a],
      // No deps.select / deps.confirm: the parsed flags drive it, as a service agent would.
    });
    expect(code).toBe(0);
    expect(out).toContain('converted the legacy identity/manifest to the current format');
    expect(JSON.parse(readFileSync(join(cwd, '.musterd', 'workspace.json'), 'utf8')).version).toBe(
      2,
    );
    expect(a.state.applied[0]?.kind).toBe('write');
  });

  it('--select without --yes still asks the conversion question (interactive stays the default)', async () => {
    writeV1Identity();
    const a = fakeAdapter('fake-a');
    const { code, out } = await run(['configure', '--select', 'fake-a'], {
      ctx: ctxOf(),
      registry: [a],
      confirm: false, // the (stubbed) interactive answer
    });
    expect(code).toBe(0);
    expect(out).toContain('no changes made');
    expect(a.state.applied).toEqual([]);
  });

  it('refuses an unknown harness id with the registry named', async () => {
    writeV2Identity();
    await expect(
      run(['configure', '--select', 'emacs', '--yes'], {
        ctx: ctxOf(),
        registry: [fakeAdapter('fake-a')],
      }),
    ).rejects.toThrow(/unknown harness id.*fake-a/s);
  });

  it('names musterd-core as internal guidance and writes nothing', async () => {
    writeV2Identity();
    writeV3Provisioning(['fake-a']);
    const before = readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8');
    const a = fakeAdapter('fake-a');
    await expect(
      run(['configure', '--select', 'fake-a,musterd-core', '--yes'], {
        ctx: ctxOf(),
        registry: [a],
      }),
    ).rejects.toThrow(
      'musterd-core is internal guidance, kept while any harness is selected — leave it out of --select',
    );
    expect(a.state.applied).toEqual([]);
    expect(readFileSync(join(cwd, '.musterd', 'provisioned.json'), 'utf8')).toBe(before);
  });

  it('names a real unknown id and musterd-core in the same refusal', async () => {
    writeV2Identity();
    await expect(
      run(['configure', '--select', 'emacs,musterd-core', '--yes'], {
        ctx: ctxOf(),
        registry: [fakeAdapter('fake-a')],
      }),
    ).rejects.toThrow(
      /unknown harness id\(s\): emacs — this build's registry is fake-a\nmusterd-core is internal guidance/,
    );
  });
});
