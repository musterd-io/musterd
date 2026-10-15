import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { CliError } from '../errors.js';

const h = vi.hoisted(() => ({
  addMember: vi.fn(async () => ({ member: { name: 'June' }, token: 'mskd_tok' })),
  roster: vi.fn(async () => ({ members: [] as Array<{ name: string; kind: string }> })),
  issueGrant: vi.fn(async () => ({
    grant: { id: 'g1', target: 'June', scope: 'seat', lifetime: 'standing' },
    token: 'msgr_standing',
  })),
  mintBootstrapCredential: vi.fn(async () => ({
    credential: { id: 'bc1', use: 'claim_seat', target: 'June' },
    agent_key: 'mskey_scoped_june',
  })),
  saveBinding: vi.fn(),
  saveWorkspaceSpec: vi.fn(),
  writeSeatFile: vi.fn(),
  reconcile: vi.fn(async () => ({ ok: true, results: [] as unknown[] })),
  // dir is set to a real temp dir per-test (the command chdir's into it to register MCP).
  workspace: { dir: '', kind: 'worktree' as const, branch: 'agent/June', created: true },
  rosterHome: {} as Record<string, string>,
  // What `seatFileUnpublished` answers for the roster home (ADR 547): null = published / not git.
  unpublished: null as 'uncommitted' | 'unpushed' | null,
  // What `publishSeatFile` answers (ADR 592); the mock below returns it.
  publish: { state: 'skipped', detail: 'test' } as {
    state: 'published' | 'already' | 'skipped' | 'failed';
    detail?: string;
  },
  publishSeatFile: vi.fn(
    (): { state: 'published' | 'already' | 'skipped' | 'failed'; detail?: string } => h.publish,
  ),
  // Mutable so a test can model the machine that has LOST the team agent key (the empty
  // `agentKeys` map an interrupted config prune leaves behind) — see the preflight suite.
  agentKeys: {} as Record<string, string>,
}));

vi.mock('./helpers.js', () => ({
  resolve: () => ({
    team: 'ritual',
    config: { server: 'http://localhost:4849', agentKeys: h.agentKeys },
    http: {
      addMember: h.addMember,
      roster: h.roster,
      issueGrant: h.issueGrant,
      mintBootstrapCredential: h.mintBootstrapCredential,
    },
  }),
}));
vi.mock('../config.js', () => ({
  loadConfig: () => ({ rosterHome: h.rosterHome }),
  saveBinding: h.saveBinding,
  saveWorkspaceSpec: h.saveWorkspaceSpec,
}));
vi.mock('../roster.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../roster.js')>();
  return {
    ...real,
    writeSeatFile: h.writeSeatFile,
    seatFileExists: () => false,
    seatFileUnpublished: () => h.unpublished,
    publishSeatFile: h.publishSeatFile,
    // The real helper calls the two above inside roster.ts, out of this mock's reach: the same
    // composition over the stubs (roster.test.ts runs the real one against a real clone).
    publishSeatFileReport: (
      name: string,
      home: string | undefined,
      opts: { publish?: boolean } = {},
    ) => {
      if (!home || h.unpublished === null) return null;
      if (opts.publish === false)
        return { outcome: null, warn: real.unpublishedSeatLines(name, home, h.unpublished) };
      const outcome = h.publishSeatFile(home, name);
      return { outcome, ...(real.seatPublishLines(name, home, outcome, h.unpublished) ?? {}) };
    },
  };
});
vi.mock('../onboard/harnesses/index.js', () => ({
  harnessAdapters: () =>
    ['claude-code', 'cursor', 'codex', 'opencode', 'grok', 'musterd'].map((id) => ({ id })),
}));
vi.mock('../onboard/reconcile/engine.js', () => ({ reconcileHarnesses: h.reconcile }));
vi.mock('../onboard/workspace.js', () => ({ provisionWorkspace: () => h.workspace }));

const { agentCommand } = await import('./agent.js');

describe('musterd agent <name>', () => {
  const cwd0 = process.cwd();
  beforeEach(() => {
    vi.clearAllMocks();
    h.rosterHome = {};
    h.unpublished = null;
    h.publish = { state: 'skipped', detail: 'test' };
    h.agentKeys = { ritual: 'mskey_team' };
    delete process.env['MUSTERD_AGENT_KEY'];
    h.workspace.dir = mkdtempSync(join(tmpdir(), 'magent-'));
  });
  afterEach(() => {
    process.chdir(cwd0); // safety: command restores cwd, but guard the suite if it ever throws mid-way
    rmSync(h.workspace.dir, { recursive: true, force: true });
  });

  describe('the infra-touch gate (ADR 227 inc 2) — this verb rewrites the machine-shared MCP entry', () => {
    it('asks the gate with verb "agent" and prints the one warn line, then PROCEEDS', async () => {
      const infraGate = vi.fn(async () => 'nick holds platform — route an ask instead (ADR 227)');
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
        chunks.push(String(c));
        return true;
      });
      let code: number;
      try {
        code = await agentCommand(parseArgs(['June']), { infraGate });
      } finally {
        spy.mockRestore();
      }
      expect(code).toBe(0); // warn-never-block: the provisioning still ran
      expect(infraGate).toHaveBeenCalledWith('agent');
      expect(chunks.join('')).toContain('nick holds platform');
      expect(h.reconcile).toHaveBeenCalled(); // proceeded through to the wiring
    });

    it('stays silent when the gate answers null — holder, human shell, or unreachable daemon', async () => {
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
        chunks.push(String(c));
        return true;
      });
      let code: number;
      try {
        code = await agentCommand(parseArgs(['June']), { infraGate: async () => null });
      } finally {
        spy.mockRestore();
      }
      expect(code).toBe(0);
      expect(chunks.join('')).not.toContain('ADR 227');
    });
  });

  it('adds the agent, binds the workspace, and registers MCP with autojoin', async () => {
    const code = await agentCommand(parseArgs(['June', '--role', 'engineer']));
    expect(code).toBe(0);

    expect(h.addMember).toHaveBeenCalledWith('ritual', {
      name: 'June',
      kind: 'agent',
      role: 'engineer',
    });
    // binding written into the workspace dir with the team agent key + seat claim (v0.3, ADR 075)
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({
        version: 2,
        team: 'ritual',
        agent_key: 'mskey_scoped_june',
        claim: { mode: 'seat', name: 'June' },
      }),
    );
    // v2 identity carries no surface (ADR 281) — runtime Surface is launcher-only (ADR 286).
    const bindingArg = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(bindingArg['surface']).toBeUndefined();
    // MCP registered with NO secret (agent_key/grant) in the harness config, so an in-tree config
    // (Cursor/Codex) is commit-safe (ADR 018/115) — and, critically, **no `MUSTERD_BINDING`** (ADR 143).
    //
    // This assertion used to be its inverse. Naming the binding file in the env looked harmless, because
    // we chdir into the worktree first — but Claude Code keys its *local* MCP scope by **repo root**, and
    // every seat worktree is a git worktree of the same repo. So the env was one global slot that each
    // `musterd agent` overwrote, and provisioning one seat re-pointed *every live session on the machine*
    // at it. On 2026-07-13 they all booted as `dolly` and superseded each other off their own seats.
    //
    // The adapter anchors on the binding it finds by walking up from its **cwd** — genuinely per-worktree,
    // unlike the shared config — so the env was never needed here. Omitting it makes the shared entry
    // identical for every seat, and therefore harmless.
    // ADR 491: wiring runs through the reconcile engine; nothing secret is handed to it (ADR 143/165).
    expect(JSON.stringify(h.reconcile.mock.calls[0])).not.toMatch(/mskey_|msgr_/);
    expect(h.reconcile.mock.calls[0]![1]).toEqual(['claude-code']);

    // The secret-free committed launch spec is written (no agent_key/grant fields).
    expect(h.saveWorkspaceSpec).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({
        version: 2,
        team: 'ritual',
        claim: { mode: 'seat', name: 'June' },
      }),
    );
    const specArg = h.saveWorkspaceSpec.mock.calls[0]![1] as Record<string, unknown>;
    expect(specArg.agent_key).toBeUndefined();
    expect(specArg.grant).toBeUndefined();
    expect(specArg['surface']).toBeUndefined();
  });

  it('records the desired set for the engine, which writes the ADR 261 floor as a ledger-owned fragment (spec §4.7(2))', async () => {
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    // The floor is the claude-code permissions fragment (claudeCodeFragments.test.ts), so
    // `uninstall` can release it; this command records intent and hands it to the engine.
    expect(
      JSON.parse(readFileSync(join(h.workspace.dir, '.musterd', 'provisioned.json'), 'utf8')),
    ).toMatchObject({ desired: ['claude-code'], toolkit: '' });
    expect(h.reconcile.mock.calls[0]![1]).toEqual(['claude-code']);
  });

  it('--profile read-only records that toolkit, whose deny ceiling the engine layers over the floor (ADR 261 decision 3)', async () => {
    const code = await agentCommand(parseArgs(['Watcher', '--profile', 'read-only']));
    expect(code).toBe(0);
    expect(
      JSON.parse(readFileSync(join(h.workspace.dir, '.musterd', 'provisioned.json'), 'utf8'))
        .toolkit,
    ).toBe('read-only');
  });

  it('--profile provisions the workspace without touching the team fact (ADR 272 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['Watcher', '--profile', 'read-only']));
    expect(code).toBe(0);
    // No role label reaches the roster from a profile pick — a profile is configuration, not identity.
    expect(h.addMember).toHaveBeenCalledWith('ritual', { name: 'Watcher', kind: 'agent' });
  });

  it('--role is the team fact only — it labels the member and provisions NOTHING (ADR 272 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['Watcher', '--role', 'read-only']));
    expect(code).toBe(0);
    expect(h.addMember).toHaveBeenCalledWith('ritual', {
      name: 'Watcher',
      kind: 'agent',
      role: 'read-only',
    });
    // Even a label that NAMES a toolkit records none — the coupling is what inc 2 removed.
    expect(
      JSON.parse(readFileSync(join(h.workspace.dir, '.musterd', 'provisioned.json'), 'utf8'))
        .toolkit,
    ).toBe('');
  });

  it('--role <label> --profile <name> sets the label from one and the workspace from the other', async () => {
    const code = await agentCommand(
      parseArgs(['Watcher', '--role', 'auditor', '--profile', 'read-only']),
    );
    expect(code).toBe(0);
    expect(h.addMember).toHaveBeenCalledWith('ritual', {
      name: 'Watcher',
      kind: 'agent',
      role: 'auditor',
    });
    expect(
      JSON.parse(readFileSync(join(h.workspace.dir, '.musterd', 'provisioned.json'), 'utf8'))
        .toolkit,
    ).toBe('read-only');
  });

  it('an unknown --profile still creates the seat — permissions are best-effort (floor-only, no throw)', async () => {
    const code = await agentCommand(parseArgs(['Zed', '--profile', 'no-such-profile']));
    expect(code).toBe(0);
  });

  it('--driver <you> records the driver in binding.json, never the shared entry (ADR 155/165 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['June', '--driver', 'nick']));
    expect(code).toBe(0);
    // The entry is repo-root-shared: a driver baked there marked EVERY sibling worktree as driven.
    // ADR 491: wiring runs through the reconcile engine; nothing secret is handed to it (ADR 143/165).
    expect(JSON.stringify(h.reconcile.mock.calls[0])).not.toMatch(/mskey_|msgr_/);
    const binding = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(binding.driver).toBe('nick');
  });

  it('writes autojoin into the binding (per-worktree), not the shared entry (ADR 165 inc 2)', async () => {
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    const binding = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(binding.autojoin).toBe(true);
    expect(binding.driver).toBeUndefined(); // opt-in: no driver unless asked (ADR 155)
  });

  it('issues a standing grant and persists it in the binding (source of truth), not the env (ADR 077)', async () => {
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    // A standing seat grant is minted so autojoin occupies without an approval request.
    expect(h.issueGrant).toHaveBeenCalledWith('ritual', {
      scope: 'seat',
      target: 'June',
      lifetime: 'standing',
    });
    // The grant is persisted in the workspace binding.json — the adapter reads it via MUSTERD_BINDING.
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({ grant: 'msgr_standing' }),
    );
    // ADR 491: wiring runs through the reconcile engine; nothing secret is handed to it (ADR 143/165).
    expect(JSON.stringify(h.reconcile.mock.calls[0])).not.toMatch(/mskey_|msgr_/);
  });

  it('still comes online if the grant mint fails (falls back to the approval lane)', async () => {
    h.issueGrant.mockRejectedValueOnce(new Error('not admin'));
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    // No grant in the binding; autojoin will route through the approval lane instead.
    const binding = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(binding.grant).toBeUndefined();
    // ADR 491: wiring runs through the reconcile engine; nothing secret is handed to it (ADR 143/165).
    expect(JSON.stringify(h.reconcile.mock.calls[0])).not.toMatch(/mskey_|msgr_/);
  });

  it('--harness cursor wires the Cursor adapter — and bakes no surface anywhere', async () => {
    const code = await agentCommand(parseArgs(['June', '--harness', 'cursor']));
    expect(code).toBe(0);
    expect(h.reconcile.mock.calls[0]![1]).toEqual(['cursor']);
    // v2 identity carries no surface (ADR 281): the launcher provides it at runtime (ADR 286).
    const bindingArg = h.saveBinding.mock.calls[0]![1] as Record<string, unknown>;
    expect(bindingArg['surface']).toBeUndefined();
    const specArg = h.saveWorkspaceSpec.mock.calls[0]![1] as Record<string, unknown>;
    expect(specArg['surface']).toBeUndefined();
    expect(JSON.stringify(h.reconcile.mock.calls[0])).not.toMatch(/MUSTERD_SURFACE/);
  });

  it('--harness codex wires the Codex adapter', async () => {
    const code = await agentCommand(parseArgs(['June', '--harness', 'codex']));
    expect(code).toBe(0);
    expect(h.reconcile.mock.calls[0]![1]).toEqual(['codex']);
  });

  it('defaults to the claude-code harness when --harness is omitted', async () => {
    await agentCommand(parseArgs(['June']));
    expect(h.reconcile.mock.calls[0]![1]).toEqual(['claude-code']);
  });

  it('rejects an unknown harness with the valid set', async () => {
    await expect(agentCommand(parseArgs(['June', '--harness', 'emacs']))).rejects.toThrow(
      /unknown harness "emacs".*claude-code, cursor, codex/s,
    );
  });

  it('writes a seat file first for a file-backed team', async () => {
    h.rosterHome = { ritual: '/home/ritual/.musterd' };
    await agentCommand(parseArgs(['June']));
    expect(h.writeSeatFile).toHaveBeenCalledWith('/home/ritual/.musterd', 'June', {
      kind: 'agent',
    });
  });

  describe('a seat file other machines cannot see yet (ADR 547 follow-up)', () => {
    const out = async (args: string[]): Promise<string> => {
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
        chunks.push(String(c));
        return true;
      });
      try {
        await agentCommand(parseArgs(args));
      } finally {
        spy.mockRestore();
      }
      return chunks.join('');
    };

    it('says the new agent is invisible to other machines until its file is committed and pushed', async () => {
      h.rosterHome = { ritual: '/home/ritual/.musterd' };
      h.unpublished = 'uncommitted';
      const text = await out(['June']);
      expect(text).toContain('other machines cannot resolve June');
      expect(text).toContain('.musterd/seats/June.toml');
      expect(text).toContain('git -C /home/ritual/.musterd add .musterd/seats/June.toml');
    });

    it('ADR 592: publishes the seat file itself and says so; --no-publish prints the lines instead', async () => {
      h.rosterHome = { ritual: '/home/ritual/.musterd' };
      h.unpublished = 'uncommitted';
      h.publish = { state: 'published' };
      const text = await out(['June']);
      expect(h.publishSeatFile).toHaveBeenCalledWith('/home/ritual/.musterd', 'June');
      expect(text).toContain('published .musterd/seats/June.toml');
      expect(text).not.toContain('other machines cannot resolve June');
      h.publishSeatFile.mockClear();
      const kept = await out(['June', '--no-publish']);
      expect(h.publishSeatFile).not.toHaveBeenCalled();
      expect(kept).toContain('other machines cannot resolve June');
      expect(kept).toContain('git -C /home/ritual/.musterd add .musterd/seats/June.toml');
    });

    it('--json publishes too, and says how (ADR 592: seat_file_published)', async () => {
      h.rosterHome = { ritual: '/home/ritual/.musterd' };
      h.unpublished = 'uncommitted';
      h.publish = { state: 'published' };
      h.publishSeatFile.mockClear();
      const body = JSON.parse(await out(['June', '--json']));
      expect(h.publishSeatFile).toHaveBeenCalledWith('/home/ritual/.musterd', 'June');
      expect(body.seat_file_published).toEqual({ state: 'published' });
    });

    it('carries the same fact in --json', async () => {
      h.rosterHome = { ritual: '/home/ritual/.musterd' };
      h.unpublished = 'unpushed';
      const body = JSON.parse(await out(['June', '--json']));
      expect(body.seat_file_unpublished).toEqual({
        path: '/home/ritual/.musterd/.musterd/seats/June.toml',
        state: 'unpushed',
      });
    });

    it('is silent when the seat file is published, and on a db-only team', async () => {
      h.rosterHome = { ritual: '/home/ritual/.musterd' };
      h.unpublished = null;
      expect(await out(['June'])).not.toContain('other machines');
      h.rosterHome = {};
      h.unpublished = 'uncommitted'; // would warn if a roster home existed
      expect(await out(['Kit'])).not.toContain('other machines');
    });
  });

  it('still succeeds when MCP registration fails (member + workspace already done)', async () => {
    h.reconcile.mockRejectedValueOnce(new Error('claude not found'));
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    expect(h.saveBinding).toHaveBeenCalled(); // workspace was still provisioned
  });

  it('is idempotent: reuses an already-declared agent seat and still (re)builds the workspace', async () => {
    // e.g. the seat was already created via `team add June` — addMember conflicts.
    h.addMember.mockRejectedValueOnce(
      new CliError('member "June" already exists in "ritual"', 9, 'conflict'),
    );
    h.roster.mockResolvedValueOnce({ members: [{ name: 'June', kind: 'agent' }] });
    const code = await agentCommand(parseArgs(['June']));
    expect(code).toBe(0);
    expect(h.saveBinding).toHaveBeenCalled(); // workspace still provisioned
    expect(h.reconcile).toHaveBeenCalled(); // still wired
  });

  it('refuses to reuse a seat that already exists as a human', async () => {
    h.addMember.mockRejectedValueOnce(
      new CliError('member "June" already exists in "ritual"', 9, 'conflict'),
    );
    h.roster.mockResolvedValueOnce({ members: [{ name: 'June', kind: 'human' }] });
    await expect(agentCommand(parseArgs(['June']))).rejects.toThrow(/as a human, not an agent/);
    expect(h.saveBinding).not.toHaveBeenCalled();
  });

  describe('a non-admin sponsor provisions the agent they created (ADR 463 §3)', () => {
    const forbidden = () =>
      new CliError('adding a member requires an admin seat (is_admin)', 4, 'forbidden');

    it('treats forbidden like a re-run when the name is already an agent, and builds the workspace', async () => {
      h.addMember.mockRejectedValueOnce(forbidden());
      h.roster.mockResolvedValueOnce({ members: [{ name: 'dana-scout', kind: 'agent' }] });
      const chunks: string[] = [];
      const spy = vi.spyOn(process.stdout, 'write').mockImplementation((c: never) => {
        chunks.push(String(c));
        return true;
      });
      let code: number;
      try {
        code = await agentCommand(parseArgs(['dana-scout']), { infraGate: async () => null });
      } finally {
        spy.mockRestore();
      }
      expect(code).toBe(0);
      // the credential is still minted through the shared sequence — the daemon decides whether
      // THIS caller may (a sponsor of the agent, or an admin), not the CLI
      expect(h.mintBootstrapCredential).toHaveBeenCalledWith('ritual', {
        use: 'claim_seat',
        target: 'dana-scout',
        label: 'claude-code:dana-scout',
      });
      expect(h.saveBinding).toHaveBeenCalled();
      expect(h.reconcile).toHaveBeenCalled();
      expect(chunks.join('')).toContain('reused');
    });

    it('still fails with the forbidden message for a name that is not on the roster', async () => {
      h.addMember.mockRejectedValueOnce(forbidden());
      h.roster.mockResolvedValueOnce({ members: [] });
      await expect(agentCommand(parseArgs(['ghost']))).rejects.toThrow(/requires an admin seat/);
      expect(h.mintBootstrapCredential).not.toHaveBeenCalled();
      expect(h.saveBinding).not.toHaveBeenCalled();
    });

    it('still fails for a name that is a human, not an agent', async () => {
      h.addMember.mockRejectedValueOnce(forbidden());
      h.roster.mockResolvedValueOnce({ members: [{ name: 'dana', kind: 'human' }] });
      await expect(agentCommand(parseArgs(['dana']))).rejects.toThrow(/requires an admin seat/);
      expect(h.saveBinding).not.toHaveBeenCalled();
    });

    it('a sponsor of another agent is refused at the credential mint, and no workspace is left', async () => {
      h.addMember.mockRejectedValueOnce(forbidden());
      h.roster.mockResolvedValueOnce({ members: [{ name: 'eve-scout', kind: 'agent' }] });
      h.mintBootstrapCredential.mockRejectedValueOnce(
        new CliError('only the sponsor of "eve-scout" may mint for it', 4, 'forbidden'),
      );
      await expect(agentCommand(parseArgs(['eve-scout']))).rejects.toThrow(/only the sponsor/);
      expect(h.saveBinding).not.toHaveBeenCalled();
    });
  });

  it('rejects a name with whitespace', async () => {
    await expect(agentCommand(parseArgs(['two words']))).rejects.toThrow(/usage/);
  });
});

describe('the agent workspace receives its own scoped bootstrap credential', () => {
  it('does not require the legacy team agent key on this machine', async () => {
    h.agentKeys = {};
    h.rosterHome = { ritual: '/tmp/ritual-home' };
    expect(await agentCommand(parseArgs(['June']), { infraGate: async () => null })).toBe(0);
    expect(h.mintBootstrapCredential).toHaveBeenCalledWith('ritual', {
      use: 'claim_seat',
      target: 'June',
      label: expect.any(String),
    });
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({ agent_key: 'mskey_scoped_june' }),
    );
  });

  it('does not fall back to an ambient legacy key', async () => {
    process.env['MUSTERD_AGENT_KEY'] = 'mskey_legacy';
    await agentCommand(parseArgs(['June']), { infraGate: async () => null });
    expect(h.saveBinding).toHaveBeenCalledWith(
      h.workspace.dir,
      expect.objectContaining({ agent_key: 'mskey_scoped_june' }),
    );
  });
});

describe('musterd agent <name> --hue (ADR 374)', () => {
  const cwd0 = process.cwd();
  beforeEach(() => {
    vi.clearAllMocks();
    h.rosterHome = {};
    h.agentKeys = { ritual: 'mskey_team' };
    h.workspace.dir = mkdtempSync(join(tmpdir(), 'magent-hue-'));
  });
  afterEach(() => {
    process.chdir(cwd0);
    rmSync(h.workspace.dir, { recursive: true, force: true });
  });

  it('writes the hue into the seat file on a file-backed team and sends it to the daemon', async () => {
    h.rosterHome = { ritual: h.workspace.dir };
    await agentCommand(parseArgs(['June', '--hue', '212']));
    expect(h.writeSeatFile).toHaveBeenCalledWith(
      h.workspace.dir,
      'June',
      expect.objectContaining({ kind: 'agent', hue: 212 }),
    );
    expect(h.addMember).toHaveBeenCalledWith('ritual', expect.objectContaining({ hue: 212 }));
  });

  it('refuses a hue off the wheel before touching anything', async () => {
    await expect(agentCommand(parseArgs(['June', '--hue', '360']))).rejects.toThrow(/0.*359/);
    expect(h.writeSeatFile).not.toHaveBeenCalled();
    expect(h.addMember).not.toHaveBeenCalled();
  });

  it('a re-run that names no --harness keeps the Workspace recorded set (review I1)', async () => {
    mkdirSync(join(h.workspace.dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(h.workspace.dir, '.musterd', 'provisioned.json'),
      JSON.stringify({
        version: 3,
        toolkit: '',
        desired: ['claude-code', 'codex'],
        contributions: {},
        provisionedAt: 'x',
      }),
    );
    await agentCommand(parseArgs(['June']));
    expect(h.reconcile.mock.calls[0]![1]).toEqual(['claude-code', 'codex']);
    h.reconcile.mockClear();
    await agentCommand(parseArgs(['June', '--harness', 'cursor']));
    expect(h.reconcile.mock.calls[0]![1]).toEqual(['cursor']);
  });
});
