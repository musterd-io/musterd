import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../errors.js';
import { readSeatFiles, writeSeatFile } from '../roster.js';
import { provisionAgentSeat, type AgentSeatInput } from './agentSeat.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-agent-seat-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function input(over: Partial<AgentSeatInput> = {}): AgentSeatInput {
  return {
    name: 'ada',
    team: 'acme',
    server: 'http://127.0.0.1:4849',
    http: {
      addMember: vi.fn(async () => ({}) as never),
      roster: vi.fn(async () => ({ members: [] }) as never),
      mintBootstrapCredential: vi.fn(async () => ({
        credential: { id: 'c' } as never,
        agent_key: 'msac_a',
      })),
      issueGrant: vi.fn(async () => ({ grant: {} as never, token: 'msgr_g' })),
      revokeBootstrapCredential: vi.fn(async () => ({ ok: true as const })),
    },
    harnesses: ['claude-code'],
    toolkit: '',
    sourceDir: dir,
    path: join(dir, 'ws'),
    reconcile: vi.fn(async () => ({ ok: true, results: [] }) as never),
    ...over,
  };
}

describe('provisionAgentSeat (ADR 491)', () => {
  it('adds the member, provisions, and wires the desired set', async () => {
    const i = input();
    const r = await provisionAgentSeat(i);
    expect(i.http.addMember).toHaveBeenCalledWith('acme', { name: 'ada', kind: 'agent' });
    expect(r).toMatchObject({ reused: false, granted: true, wiringError: null });
    expect(r.workspace.dir).toBe(join(dir, 'ws'));
  });

  it('an existing agent is reused, not an error', async () => {
    const conflict = new CliError('exists', 9, 'conflict');
    const i = input();
    (i.http.addMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(conflict);
    (i.http.roster as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      members: [{ name: 'ada', kind: 'agent' }],
    });
    expect((await provisionAgentSeat(i)).reused).toBe(true);
  });

  it('refuses a name that belongs to a human', async () => {
    const i = input();
    (i.http.addMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CliError('exists', 9, 'conflict'),
    );
    (i.http.roster as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      members: [{ name: 'ada', kind: 'human' }],
    });
    await expect(provisionAgentSeat(i)).rejects.toThrow(/as a human, not an agent/);
  });

  it('never rewrites an existing seat file — a human seat stays human, an agent keeps its role (review I3)', async () => {
    const home = join(dir, 'roster');
    writeSeatFile(home, 'nick', { kind: 'human', role: 'founder' });
    const i = input({ name: 'nick', rosterHome: home });
    (i.http.addMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CliError('exists', 9, 'conflict'),
    );
    (i.http.roster as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      members: [{ name: 'nick', kind: 'human' }],
    });
    await expect(provisionAgentSeat(i)).rejects.toThrow(/as a human/);
    expect(readSeatFiles(home)['nick']).toMatchObject({ kind: 'human', role: 'founder' });

    writeSeatFile(home, 'ada', { kind: 'agent', role: 'engineer' });
    const j = input({ rosterHome: home });
    (j.http.addMember as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new CliError('exists', 9, 'conflict'),
    );
    (j.http.roster as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      members: [{ name: 'ada', kind: 'agent' }],
    });
    await provisionAgentSeat(j);
    expect(readSeatFiles(home)['ada']).toMatchObject({ kind: 'agent', role: 'engineer' });
  });
});
