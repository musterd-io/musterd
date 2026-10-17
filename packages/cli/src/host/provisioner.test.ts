import type { Binding, HostProvision } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { Harness } from '../onboard/harness.js';
import { provisionOnce, type ProvisionDeps } from './provisioner.js';

/** ADR 463 §3 — the sponsor host's provisioner, every collaborator faked. */
const row = (over: Partial<HostProvision> = {}): HostProvision => ({
  id: '01PROV',
  team: 'acme',
  agent: 'dana-scout',
  sponsor: 'dana',
  host: 'dana-mbp',
  state: 'claimed',
  claimed_by: 'dana-mbp',
  claimed_at: 1000,
  ready_at: null,
  failed_reason: null,
  created_at: 900,
  ...over,
});

const harness = { id: 'claude-code', label: 'Claude Code' } as unknown as Harness;
const WS = {
  dir: '/ws/dana-scout',
  kind: 'worktree' as const,
  branch: 'agent/dana-scout',
  created: true,
};

function deps(over: Partial<ProvisionDeps> = {}, rows: HostProvision[] = [row()]) {
  const log = vi.fn();
  const client = {
    claimProvisions: vi.fn(async () => ({ provisions: rows })),
    reportProvision: vi.fn(async (_t: string, _id: string, body: unknown) => ({
      provision: { ...rows[0]!, state: (body as { state: string }).state } as HostProvision,
    })),
  };
  const sponsor = {
    mintBootstrapCredential: vi.fn(),
    issueGrant: vi.fn(),
    enrollResidency: vi.fn(
      async (_t: string, b: { seat: string; harness: string; host: string }) => ({
        residency: { seat: b.seat, harness: b.harness, host: b.host },
        grant: 'msgr_rotated',
      }),
    ),
  };
  const provisionWorkspace = vi.fn(() => WS);
  const provisionSeat = vi.fn(async (input: { workspace: () => typeof WS }) => ({
    workspace: input.workspace(),
    agentKey: 'msac_x',
    granted: true,
    wiring: null,
    wiringError: null,
  }));
  const upsertHostEntry = vi.fn();
  const writeBinding = vi.fn();
  const d: ProvisionDeps = {
    client: client as never,
    sponsor: sponsor as never,
    team: 'acme',
    server: 'http://localhost:4849',
    host: 'dana-mbp',
    hostKey: 'msak_host',
    harness,
    repoRoot: '/repo',
    clone: false,
    log,
    provisionWorkspace: provisionWorkspace as never,
    provisionSeat: provisionSeat as never,
    upsertHostEntry: upsertHostEntry as never,
    loadRegistry: () => ({ entries: [] }),
    existsSync: () => false,
    readBinding: () => ({ claim: { mode: 'seat', name: 'dana-scout' } }) as unknown as Binding,
    writeBinding: writeBinding as never,
    ...over,
  };
  return {
    d,
    log,
    client,
    sponsor,
    provisionWorkspace,
    provisionSeat,
    upsertHostEntry,
    writeBinding,
  };
}

describe('provisionOnce (ADR 463 §3)', () => {
  it('stands a claimed agent up, enrolls it, registers it for the wake loop, and reports ready', async () => {
    const t = deps();
    const r = await provisionOnce(t.d);
    expect(r).toEqual({ claimed: 1, ready: 1, failed: 0 });
    expect(t.client.claimProvisions).toHaveBeenCalledWith('acme', 'dana-mbp');
    expect(t.provisionSeat).toHaveBeenCalledTimes(1);
    expect(t.provisionSeat.mock.calls[0]![0]).toMatchObject({
      team: 'acme',
      name: 'dana-scout',
      server: 'http://localhost:4849',
      wiring: { desired: ['claude-code'], toolkit: '' },
      http: t.sponsor,
    });
    // the workspace factory carries the team and the host's repo, and --clone off
    t.provisionSeat.mock.calls[0]![0].workspace();
    expect(t.provisionWorkspace).toHaveBeenCalledWith('dana-scout', {
      team: 'acme',
      cwd: '/repo',
      clone: false,
    });
    expect(t.sponsor.enrollResidency).toHaveBeenCalledWith('acme', {
      seat: 'dana-scout',
      harness: 'claude-code',
      host: 'dana-mbp',
    });
    // the rotated grant and the host key land in the seat's binding, so the wake loop can poll
    expect(t.writeBinding).toHaveBeenCalledWith(
      '/ws/dana-scout',
      expect.objectContaining({ grant: 'msgr_rotated', host_key: 'msak_host' }),
    );
    expect(t.upsertHostEntry).toHaveBeenCalledWith({
      server: 'http://localhost:4849',
      team: 'acme',
      seat: 'dana-scout',
      workspace: '/ws/dana-scout',
      harness: 'claude-code',
      host: 'dana-mbp',
    });
    expect(t.client.reportProvision).toHaveBeenCalledWith('acme', '01PROV', { state: 'ready' });
  });

  it('records key_env on the registry entry when one is named (ADR 648)', async () => {
    const t = deps({ keyEnv: 'ANTHROPIC_API_KEY' });
    await provisionOnce(t.d);
    expect(t.upsertHostEntry).toHaveBeenCalledWith(
      expect.objectContaining({ key_env: 'ANTHROPIC_API_KEY' }),
    );
  });

  it('passes --clone through to the workspace', async () => {
    const t = deps({ clone: true });
    await provisionOnce(t.d);
    t.provisionSeat.mock.calls[0]![0].workspace();
    expect(t.provisionWorkspace).toHaveBeenCalledWith('dana-scout', {
      team: 'acme',
      cwd: '/repo',
      clone: true,
    });
  });

  it('a seat/credential failure reports failed {credential}, and nothing is enrolled', async () => {
    const t = deps();
    t.provisionSeat.mockRejectedValueOnce(new Error('forbidden'));
    const r = await provisionOnce(t.d);
    expect(r).toEqual({ claimed: 1, ready: 0, failed: 1 });
    expect(t.client.reportProvision).toHaveBeenCalledWith('acme', '01PROV', {
      state: 'failed',
      reason: 'credential',
    });
    expect(t.sponsor.enrollResidency).not.toHaveBeenCalled();
    expect(t.upsertHostEntry).not.toHaveBeenCalled();
  });

  it('a workspace failure reports failed {workspace}', async () => {
    const t = deps();
    t.provisionWorkspace.mockImplementationOnce(() => {
      throw new Error('git worktree add failed');
    });
    t.provisionSeat.mockImplementationOnce(async (input: { workspace: () => typeof WS }) => ({
      workspace: input.workspace(),
      agentKey: 'x',
      granted: true,
      wiring: null,
      wiringError: null,
    }));
    await provisionOnce(t.d);
    expect(t.client.reportProvision).toHaveBeenCalledWith('acme', '01PROV', {
      state: 'failed',
      reason: 'workspace',
    });
    expect(t.sponsor.enrollResidency).not.toHaveBeenCalled();
  });

  it('an enroll failure reports failed {enroll}', async () => {
    const t = deps();
    t.sponsor.enrollResidency.mockRejectedValueOnce(new Error('403'));
    await provisionOnce(t.d);
    expect(t.client.reportProvision).toHaveBeenCalledWith('acme', '01PROV', {
      state: 'failed',
      reason: 'enroll',
    });
    expect(t.upsertHostEntry).not.toHaveBeenCalled();
  });

  it('Review Focus 5: a Workspace already bound to the seat is not provisioned twice', async () => {
    const t = deps({
      loadRegistry: () => ({
        entries: [
          {
            server: 'http://localhost:4849',
            team: 'acme',
            seat: 'dana-scout',
            workspace: '/ws/existing',
            harness: 'claude-code',
            host: 'dana-mbp',
            updated_at: 1,
          },
        ],
      }),
      existsSync: () => true,
    });
    const r = await provisionOnce(t.d);
    expect(r.ready).toBe(1);
    expect(t.provisionWorkspace).not.toHaveBeenCalled();
    expect(t.provisionSeat).not.toHaveBeenCalled(); // no second credential minted over a live one
    expect(t.sponsor.enrollResidency).toHaveBeenCalledTimes(1);
    expect(t.upsertHostEntry).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: '/ws/existing' }),
    );
    expect(t.client.reportProvision).toHaveBeenCalledWith('acme', '01PROV', { state: 'ready' });
  });

  it('a registry entry whose Workspace binds a DIFFERENT seat is not reused', async () => {
    const t = deps({
      loadRegistry: () => ({
        entries: [
          {
            server: 's',
            team: 'acme',
            seat: 'dana-scout',
            workspace: '/ws/other',
            harness: 'claude-code',
            host: 'dana-mbp',
            updated_at: 1,
          },
        ],
      }),
      existsSync: () => true,
      readBinding: () => ({ claim: { mode: 'seat', name: 'someone-else' } }) as unknown as Binding,
    });
    await provisionOnce(t.d);
    expect(t.provisionSeat).toHaveBeenCalledTimes(1);
  });

  it('a failing claim is logged and never throws; nothing is reported', async () => {
    const t = deps();
    t.client.claimProvisions.mockRejectedValueOnce(new Error('daemon down'));
    await expect(provisionOnce(t.d)).resolves.toEqual({ claimed: 0, ready: 0, failed: 0 });
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('provision claim failed'));
    expect(t.client.reportProvision).not.toHaveBeenCalled();
  });

  it('one failing row never stops the next, and a lost report is only logged', async () => {
    const rows = [row({ id: 'A', agent: 'a-scout' }), row({ id: 'B', agent: 'b-scout' })];
    const t = deps({}, rows);
    t.provisionSeat.mockRejectedValueOnce(new Error('boom'));
    t.client.reportProvision.mockRejectedValueOnce(new Error('report lost'));
    const r = await provisionOnce(t.d);
    expect(r).toEqual({ claimed: 2, ready: 1, failed: 1 });
    expect(t.log).toHaveBeenCalledWith(expect.stringContaining('provision report failed'));
    expect(t.client.reportProvision).toHaveBeenLastCalledWith('acme', 'B', { state: 'ready' });
  });

  it('a quiet tick logs nothing', async () => {
    const t = deps({}, []);
    await provisionOnce(t.d);
    expect(t.log).not.toHaveBeenCalled();
  });
});
