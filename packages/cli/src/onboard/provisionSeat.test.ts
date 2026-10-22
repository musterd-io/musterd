import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bundledSkillsRoot, shippedSkillFiles } from '../roster-roles/skills.js';
import { provisionSeat, type ProvisionSeatInput } from './provisionSeat.js';
import type { Workspace } from './workspace.js';

/**
 * ADR 463 §3 / ADR 491 — the one seat-provisioning sequence, shared by `musterd agent`, a sponsor's
 * host and the launcher. Real files in a tmp Workspace; only the daemon (`http`) and the reconcile
 * engine are faked.
 */
let dir: string;
let ws: Workspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-provision-seat-'));
  ws = { dir, kind: 'folder', created: true };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const report = (ok = true) => ({
  ok,
  results: ok
    ? []
    : [
        {
          harness: 'claude-code',
          resourceKey: 'k',
          scope: 'folder',
          action: 'write',
          result: 'failed',
          recovery: 'none',
          detail: 'claude not found',
        },
      ],
});

function input(over: Partial<ProvisionSeatInput> = {}): ProvisionSeatInput {
  return {
    team: 'acme',
    name: 'dana-scout',
    server: 'http://localhost:4849',
    http: {
      mintBootstrapCredential: vi.fn(async () => ({
        credential: { id: 'cred-1' } as never,
        agent_key: 'msac_x',
      })),
      issueGrant: vi.fn(async () => ({ grant: {} as never, token: 'msgr_y' })),
      revokeBootstrapCredential: vi.fn(async () => ({ ok: true as const })),
    },
    workspace: () => ws,
    wiring: {
      desired: ['claude-code', 'musterd'],
      toolkit: '',
      reconcile: vi.fn(async () => report() as never),
    },
    ...over,
  };
}

const readBinding = () => JSON.parse(readFileSync(join(dir, '.musterd', 'binding.json'), 'utf8'));

describe('provisionSeat — toolkit auto-provisioning (ADR 708)', () => {
  it("provisions the recorded toolkit's servers into the wired harnesses and records role-tools", async () => {
    const r = await provisionSeat(
      input({
        wiring: {
          desired: ['opencode'],
          toolkit: 'ios',
          reconcile: vi.fn(async () => report() as never),
        },
      }),
    );
    expect(r.wiringError).toBeNull();
    expect(r.toolkitProvision).toHaveLength(1);
    expect(r.toolkitProvision[0]).toMatchObject({
      harness: 'opencode',
      servers: ['expo', 'xcodebuild', 'apple-docs'],
    });
    const oc = JSON.parse(readFileSync(join(dir, '.opencode', 'opencode.json'), 'utf8')) as {
      mcp: Record<string, unknown>;
    };
    expect(oc.mcp['expo']).toEqual({ type: 'remote', url: 'https://mcp.expo.dev/mcp' });
    expect(oc.mcp['xcodebuild']).toMatchObject({ type: 'local' });
    const provisioned = JSON.parse(
      readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'),
    ) as { toolkit: string; contributions: Record<string, string[]> };
    expect(provisioned.toolkit).toBe('ios');
    expect(provisioned.contributions['role-tools']).toEqual([
      'role-server opencode expo',
      'role-server opencode xcodebuild',
      'role-server opencode apple-docs',
    ]);
  });

  it('records the held role toolkit when the caller named none', async () => {
    const roster = join(dir, 'roster');
    mkdirSync(join(roster, '.musterd', 'seats'), { recursive: true });
    mkdirSync(join(roster, '.musterd', 'roles'), { recursive: true });
    writeFileSync(
      join(roster, '.musterd', 'seats', 'dana-scout.toml'),
      'kind = "agent"\nrole = "ios-engineer"\n',
    );
    writeFileSync(
      join(roster, '.musterd', 'roles', 'ios-engineer.toml'),
      'summary = "iOS"\ntoolkit = "ios"\nskill = "ios-engineer"\n',
    );
    const r = await provisionSeat(
      input({
        rosterHome: roster,
        role: 'ios-engineer',
        wiring: {
          desired: ['opencode'],
          toolkit: '',
          reconcile: vi.fn(async () => report() as never),
        },
      }),
    );
    const provisioned = JSON.parse(readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'));
    expect(provisioned.toolkit).toBe('ios');
    expect(r.toolkitProvision[0]).toMatchObject({
      harness: 'opencode',
      servers: ['expo', 'xcodebuild', 'apple-docs'],
    });
    const shipped = shippedSkillFiles(bundledSkillsRoot(), 'ios-engineer');
    const installed = join(dir, '.agents', 'skills', 'ios-engineer');
    expect(readFileSync(join(installed, 'SKILL.md'), 'utf8')).toMatch(/^name: ios-engineer$/m);
    expect(readFileSync(join(installed, 'references', 'team.md'))).toEqual(
      shipped.get(join('references', 'team.md')),
    );
    expect(r.skillNotes.join('\n')).not.toMatch(/not a bundled built-in/);
  });

  it('reports an unloadable recorded toolkit without provisioning or throwing', async () => {
    const r = await provisionSeat(
      input({
        wiring: {
          desired: ['opencode'],
          toolkit: 'no-such-toolkit',
          reconcile: vi.fn(async () => report() as never),
        },
      }),
    );
    expect(r.wiringError).toBeNull();
    expect(r.toolkitProvision.some((o) => o.error?.includes('unknown toolkit'))).toBe(true);
    expect(existsSync(join(dir, '.opencode', 'opencode.json'))).toBe(false);
  });

  it('provisions nothing for the generalist toolkit or no toolkit', async () => {
    const generalist = await provisionSeat(
      input({
        wiring: {
          desired: ['opencode'],
          toolkit: 'generalist',
          reconcile: vi.fn(async () => report() as never),
        },
      }),
    );
    expect(generalist.toolkitProvision).toEqual([]);
    expect(existsSync(join(dir, '.opencode', 'opencode.json'))).toBe(false);
  });
});

describe('provisionSeat (ADR 463 §3, ADR 491)', () => {
  it('writes the binding 0600, the secret-free spec and provisioned.json, then reconciles once', async () => {
    const i = input({ model: 'claude-opus-5-5', driver: 'dana' });
    const r = await provisionSeat(i);
    expect(r).toMatchObject({ agentKey: 'msac_x', granted: true, wiringError: null });
    expect(r.workspace).toBe(ws);

    expect(readBinding()).toMatchObject({
      version: 2,
      server: 'http://localhost:4849',
      team: 'acme',
      agent_key: 'msac_x',
      grant: 'msgr_y',
      claim: { mode: 'seat', name: 'dana-scout' },
      autojoin: true,
      model: 'claude-opus-5-5',
      driver: 'dana',
    });
    expect(statSync(join(dir, '.musterd', 'binding.json')).mode & 0o777).toBe(0o600);

    const spec = readFileSync(join(dir, '.musterd', 'workspace.json'), 'utf8');
    expect(JSON.parse(spec)).toMatchObject({
      team: 'acme',
      claim: { mode: 'seat', name: 'dana-scout' },
    });
    expect(spec).not.toMatch(/msac_x|msgr_y|agent_key|grant/);

    const reconcile = i.wiring.reconcile as unknown as ReturnType<typeof vi.fn>;
    expect(reconcile).toHaveBeenCalledTimes(1);
    const [ctx, desired, opts] = reconcile.mock.calls[0] as [
      { worktreeRoot: string; team?: string },
      string[],
      { legacyRepair: boolean },
    ];
    expect(ctx.worktreeRoot).toBe(realpathSync(dir));
    expect(ctx.team).toBe('acme');
    expect(desired).toEqual(['claude-code', 'musterd']);
    expect(opts.legacyRepair).toBe(false);
    const prov = JSON.parse(readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'));
    expect(prov).toMatchObject({
      version: 3,
      toolkit: '',
      desired: ['claude-code', 'musterd'],
      contributions: {},
    });
  });

  it('never writes the permissions floor itself — the engine fragment owns it (spec §4.7(2))', async () => {
    await provisionSeat(input());
    expect(existsSync(join(dir, '.claude', 'settings.local.json'))).toBe(false);
  });

  it('mints a credential scoped to this one seat, labelled by its first harness', async () => {
    const i = input();
    await provisionSeat(i);
    expect(i.http.mintBootstrapCredential).toHaveBeenCalledWith('acme', {
      use: 'claim_seat',
      target: 'dana-scout',
      label: 'claude-code:dana-scout',
    });
    expect(i.http.issueGrant).toHaveBeenCalledWith('acme', {
      scope: 'seat',
      target: 'dana-scout',
      lifetime: 'standing',
    });
  });

  it('a failed mint throws BEFORE the workspace exists — no worktree is left behind', async () => {
    const workspace = vi.fn(() => ws);
    await expect(
      provisionSeat(
        input({
          workspace,
          http: {
            mintBootstrapCredential: vi.fn(async () => {
              throw new Error('forbidden');
            }),
            issueGrant: vi.fn(),
          },
        }),
      ),
    ).rejects.toThrow('forbidden');
    expect(workspace).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.musterd'))).toBe(false);
  });

  it('a failed grant never fails the seat: it is bound without one', async () => {
    const r = await provisionSeat(
      input({
        http: {
          mintBootstrapCredential: vi.fn(async () => ({
            credential: {} as never,
            agent_key: 'msac_x',
          })),
          issueGrant: vi.fn(async () => {
            throw new Error('not admin');
          }),
        },
      }),
    );
    expect(r.granted).toBe(false);
    expect(readBinding().grant).toBeUndefined();
    expect(readBinding().agent_key).toBe('msac_x');
  });

  it('reports incomplete wiring without throwing — the binding is already written', async () => {
    const i = input({
      wiring: {
        desired: ['claude-code'],
        toolkit: '',
        reconcile: vi.fn(async () => report(false) as never),
      },
    });
    const r = await provisionSeat(i);
    expect(r.wiringError).toBe('claude-code: failed — claude not found');
    expect(readBinding().claim).toEqual({ mode: 'seat', name: 'dana-scout' });
  });

  it('keeps the prior contributions when it re-provisions a Workspace', async () => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 3,
        toolkit: 'old',
        desired: ['codex'],
        contributions: { codex: ['k1'] },
        provisionedAt: 'x',
      }),
    );
    await provisionSeat(input());
    const prov = JSON.parse(readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'));
    expect(prov.contributions).toEqual({ codex: ['k1'] });
    expect(prov.desired).toEqual(['claude-code', 'musterd']);
  });

  it('revokes the minted credential when the Workspace cannot be made, then rethrows', async () => {
    const i = input({
      workspace: () => {
        throw new Error('disk full');
      },
    });
    await expect(provisionSeat(i)).rejects.toThrow('disk full');
    expect(i.http.revokeBootstrapCredential).toHaveBeenCalledWith('acme', 'cred-1');
  });

  it('restores the process cwd after wiring, even when reconcile throws', async () => {
    const before = process.cwd();
    const i = input({
      wiring: {
        desired: ['claude-code'],
        toolkit: '',
        reconcile: vi.fn(async () => {
          throw new Error('x');
        }),
      },
    });
    const r = await provisionSeat(i);
    expect(r.wiringError).toBe('x');
    expect(process.cwd()).toBe(before);
  });

  it('omits model and driver when none is declared (never a guess)', async () => {
    await provisionSeat(input());
    const b = readBinding();
    expect(b.model).toBeUndefined();
    expect(b.driver).toBeUndefined();
  });

  it('keeps the recorded desired set and toolkit when the caller named neither (review I1)', async () => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 3,
        toolkit: 'old',
        desired: ['claude-code', 'codex'],
        contributions: {},
        provisionedAt: 'x',
      }),
    );
    const i = input({
      wiring: {
        desired: ['claude-code'],
        toolkit: '',
        keepDesired: true,
        keepToolkit: true,
        reconcile: vi.fn(async () => report() as never),
      },
    });
    await provisionSeat(i);
    const prov = JSON.parse(readFileSync(join(dir, '.musterd', 'provisioned.json'), 'utf8'));
    expect(prov).toMatchObject({ desired: ['claude-code', 'codex'], toolkit: 'old' });
    expect((i.wiring.reconcile as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toEqual([
      'claude-code',
      'codex',
    ]);
  });

  it('revokes the credential when writing the binding fails after the mint (review I4)', async () => {
    const file = join(dir, 'not-a-folder');
    writeFileSync(file, 'x');
    const i = input({ workspace: () => ({ dir: file, kind: 'folder', created: false }) });
    await expect(provisionSeat(i)).rejects.toThrow();
    expect(i.http.revokeBootstrapCredential).toHaveBeenCalledWith('acme', 'cred-1');
  });

  it('a selected harness that is not installed is incomplete wiring, not wired (review I5)', async () => {
    const pending = {
      ok: true,
      results: [
        {
          harness: 'codex',
          resourceKey: '',
          scope: '',
          action: 'none',
          result: 'pending',
          recovery: 'none',
          detail: 'codex not found',
        },
      ],
    };
    const r = await provisionSeat(
      input({
        wiring: { desired: ['codex'], toolkit: '', reconcile: vi.fn(async () => pending as never) },
      }),
    );
    expect(r.wiringError).toBe('codex: pending — codex not found');
  });
});
