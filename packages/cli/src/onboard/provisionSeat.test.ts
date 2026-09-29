import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Harness } from './harness.js';
import { provisionSeat, type ProvisionSeatInput } from './provisionSeat.js';
import type { Workspace } from './workspace.js';

/**
 * ADR 463 §3 — the one seat-provisioning sequence, shared by `musterd agent` and a sponsor's host.
 * Real files in a tmp Workspace; only the daemon (`http`) and the harness are faked.
 */
let dir: string;
let ws: Workspace;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-provision-seat-'));
  ws = { dir, kind: 'folder', created: true };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeHarness(configure = vi.fn(async () => ({ target: 'fake', activation: '' }))) {
  return {
    harness: { id: 'claude-code', label: 'Claude Code', configure } as unknown as Harness,
    configure,
  };
}

function input(over: Partial<ProvisionSeatInput> = {}): ProvisionSeatInput {
  return {
    team: 'acme',
    name: 'dana-scout',
    server: 'http://localhost:4849',
    harness: fakeHarness().harness,
    http: {
      mintBootstrapCredential: vi.fn(async () => ({
        credential: {} as never,
        agent_key: 'msac_x',
      })),
      issueGrant: vi.fn(async () => ({ grant: {} as never, token: 'msgr_y' })),
    },
    workspace: () => ws,
    ...over,
  };
}

const readBinding = () => JSON.parse(readFileSync(join(dir, '.musterd', 'binding.json'), 'utf8'));

describe('provisionSeat (ADR 463 §3)', () => {
  it('writes the seat’s binding 0600, the secret-free spec, and wires the harness once', async () => {
    const { harness, configure } = fakeHarness();
    const r = await provisionSeat(
      input({ harness, model: 'claude-opus-5-5', driver: 'dana', profileName: undefined }),
    );
    expect(r).toMatchObject({ agentKey: 'msac_x', granted: true, mcpError: null });
    expect(r.workspace).toBe(ws);

    const binding = readBinding();
    expect(binding).toMatchObject({
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

    expect(configure).toHaveBeenCalledTimes(1);
    const [entry, agentBinding] = configure.mock.calls[0] as unknown as [
      { env?: Record<string, string> },
      { agent_key: string },
    ];
    // The shared harness entry never carries a secret (ADR 143/165).
    expect(JSON.stringify(entry)).not.toMatch(/msac_x|msgr_y/);
    expect(agentBinding.agent_key).toBe('msac_x');
  });

  it('mints a credential scoped to this one seat, labelled by harness', async () => {
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

  it('a failed harness wiring is reported, not thrown, and leaves the binding written', async () => {
    const { harness } = fakeHarness(
      vi.fn(async () => {
        throw new Error('claude not installed');
      }),
    );
    const before = process.cwd();
    const r = await provisionSeat(input({ harness }));
    expect(r.mcpError).toBe('claude not installed');
    expect(readBinding().agent_key).toBe('msac_x');
    // The chdir the wiring needs is always undone.
    expect(process.cwd()).toBe(before);
  });

  it('omits model and driver when none is declared (never a guess)', async () => {
    await provisionSeat(input());
    const b = readBinding();
    expect(b.model).toBeUndefined();
    expect(b.driver).toBeUndefined();
  });
});
