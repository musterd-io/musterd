import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResidencyPolicySchema, bindingSeat } from '@musterd/protocol';
import { describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import type { HostRegistryEntry } from '../host/registry.js';
import {
  collectPolicyFlags,
  ensureHostKey,
  harnessClassError,
  harnessDrift,
  policyFlags,
  registryDrift,
  renderPolicy,
  residencyCommand,
  seatWorkspace,
} from './residency.js';

/**
 * The drift lines are the remediation, so their wording is the contract (ADR 131 §1). Both faults
 * distinguished here were hit for real on the dogfood machine within one day of each other, and in
 * both cases the operator's next action came entirely from this text.
 */
const entry = (over: Partial<HostRegistryEntry> = {}): HostRegistryEntry => ({
  server: 'http://s1',
  team: 'revive',
  seat: 'izzo',
  workspace: '/ws/izzo',
  harness: 'claude-code',
  host: 'mac.lan',
  updated_at: 1,
  ...over,
});

const enrolled = [{ seat: 'izzo', host: 'mac.lan' }];

describe('registryDrift — the enrollment↔registry cross-check', () => {
  it('says nothing when the workspace holds a binding', () => {
    expect(registryDrift(enrolled, [entry()], 'revive', 'mac.lan', () => true)).toEqual([]);
  });

  it('every remediation names --seat and --workspace, run from an admin Workspace (ADR 442)', () => {
    // `--as` is gone. The hint used to print it, and nick ran that on 2026-10-21. The command
    // runs from the admin's own Workspace; the flags name the agent and its folder.
    const missing = registryDrift(enrolled, [], 'revive', 'mac.lan', () => false);
    const vanished = registryDrift(enrolled, [entry()], 'revive', 'mac.lan', () => false);
    expect(missing).toHaveLength(1);
    expect(vanished).toHaveLength(1);
    for (const line of [...missing, ...vanished]) {
      expect(line).toContain('musterd residency on --seat izzo --workspace <its folder>');
      expect(line).toContain("from an admin's own Workspace");
      expect(line).not.toContain('--as');
    }
    // No registry row: the folder is unknown, so the placeholder stays.
    expect(missing[0]).not.toContain('/ws/izzo');
    // The registered path is gone. Do not tell the reader to pass it.
    expect(vanished[0]).not.toContain('--workspace /ws/izzo');
  });

  it('skips a seat the roster binds to another node, even when its host label is ours (lane 01M41NQ05V)', () => {
    // The hub and the joiner both answer `mac.lan`: on the hub, a joiner seat matched this
    // machine's label and read as missing from its registry, with a remedy that would re-home it.
    const both = [
      { seat: 'izzo', host: 'mac.lan' },
      { seat: 'dreamy', host: 'mac.lan' },
    ];
    const lines = registryDrift(both, [], 'revive', 'mac.lan', () => false, new Set(['dreamy']));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('"izzo"');
    expect(lines.join('\n')).not.toContain('dreamy');
  });

  it('a vanished workspace and an unprovisioned one are different sentences', () => {
    // Vanished: nothing at the path at all — an abandoned worktree the registry outlived.
    const vanished = registryDrift(enrolled, [entry()], 'revive', 'mac.lan', () => false);
    expect(vanished[0]).toContain('/ws/izzo no longer exists');
    expect(vanished[0]).toContain("the seat's real workspace");

    // Unprovisioned: the directory is there, the binding is not.
    const bare = registryDrift(
      enrolled,
      [entry()],
      'revive',
      'mac.lan',
      (p) => !p.includes('.musterd'),
    );
    expect(bare[0]).toContain('/ws/izzo has no binding');
    // The folder is there, so the hint names it. The command still runs from the admin's Workspace.
    expect(bare[0]).toContain('musterd residency on --seat izzo --workspace /ws/izzo');
    expect(bare[0]).toContain("from an admin's own Workspace");
  });

  it('ignores enrollments on host labels this machine has never answered to', () => {
    const elsewhere = [{ seat: 'izzo', host: 'other.lan' }];
    expect(registryDrift(elsewhere, [], 'revive', 'mac.lan', () => false)).toEqual([]);
  });

  it('scopes to the team — another team’s entry is not this team’s registry', () => {
    const otherTeam = [entry({ team: 'dawn' })];
    const lines = registryDrift(enrolled, otherTeam, 'revive', 'mac.lan', () => true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('missing from this machine');
  });
});

describe('residency usage and harness classes', () => {
  it('the usage line names --seat and --workspace, and does not name --as', async () => {
    await expect(residencyCommand(parseArgs(['nope']))).rejects.toThrow(
      /--seat <agent> --workspace <its folder>.*from an admin's own Workspace/s,
    );
    await expect(residencyCommand(parseArgs(['nope']))).rejects.not.toThrow(/--as/);
  });

  it('a missing harness and a guess like claude name the known classes', () => {
    const known = 'claude-code, cursor, codex, opencode, grok, muse, musterd';
    expect(harnessClassError(undefined)).toBe(
      `no harness — pass --harness <class>, one of: ${known}`,
    );
    expect(harnessClassError('claude')).toBe(`unknown harness "claude" — choose from: ${known}`);
    expect(harnessClassError('claude-code')).toBeNull();
  });
});

/**
 * ADR 221. Once a missing harness binary defers instead of failing, the act stops dying after three
 * attempts — it waits, correctly, but it waits *silently and indefinitely*. That trade is only
 * honest if the condition is visible, so this line is the other half of the fix, not decoration.
 */
describe('harnessDrift — can this host actually actuate what it is enrolled for', () => {
  const here = [{ seat: 'gptbot', host: 'mac.lan', harness: 'codex' }];

  it('says nothing when the harness resolves', () => {
    expect(harnessDrift(here, 'mac.lan', () => true)).toEqual([]);
  });

  it('names the seat, the harness, and the consequence when it does not resolve', () => {
    const [line] = harnessDrift(here, 'mac.lan', () => false);
    expect(line).toContain('gptbot');
    expect(line).toContain('codex');
    // The reader's next action has to be in the sentence — that is what made the 2026-08-04
    // incident cost a manual round-trip instead of being self-serve.
    expect(line).toMatch(/defer/i);
  });

  // Only this machine's problem is this machine's business. A seat enrolled elsewhere resolving
  // nothing here is not drift — it is someone else's host, and warning about it trains the reader
  // to ignore the line.
  it('ignores seats enrolled to another host', () => {
    const elsewhere = [{ seat: 'ryder', host: 'other.lan', harness: 'claude-code' }];
    expect(harnessDrift(elsewhere, 'mac.lan', () => false)).toEqual([]);
  });

  it('reports each unresolvable harness once, not once per seat sharing it', () => {
    const two = [
      { seat: 'a', host: 'mac.lan', harness: 'codex' },
      { seat: 'b', host: 'mac.lan', harness: 'codex' },
    ];
    expect(harnessDrift(two, 'mac.lan', () => false)).toHaveLength(1);
  });
});

describe('ensureHostKey (ADR 395)', () => {
  const binding = {
    version: 2 as const,
    server: 'http://s1',
    team: 'revive',
    claim: { mode: 'seat' as const, name: 'delta' },
    agent_key: 'mskey_claim_seat',
  };

  it('reuses an existing host_key and does not mint', async () => {
    const mint = vi.fn(async () => 'mskey_should_not_mint');
    await expect(
      ensureHostKey({ ...binding, host_key: 'mskey_host' }, 'delta-host', mint),
    ).resolves.toBe('mskey_host');
    expect(mint).not.toHaveBeenCalled();
  });

  it('mints a host-scoped credential when the binding has none', async () => {
    const mint = vi.fn(async () => 'mskey_host_minted');
    await expect(ensureHostKey(binding, 'delta-host', mint)).resolves.toBe('mskey_host_minted');
    expect(mint).toHaveBeenCalledTimes(1);
    expect(mint).toHaveBeenCalledWith('delta-host');
  });
});

describe('seatWorkspace — which folder receives the grant (ADR 442)', () => {
  const bind = (dir: string, seat: string) => {
    mkdirSync(join(dir, '.musterd'), { recursive: true });
    writeFileSync(
      join(dir, '.musterd', 'binding.json'),
      JSON.stringify({
        version: 2,
        server: 'http://127.0.0.1:1',
        team: 'dawn',
        claim: { mode: 'seat', name: seat },
        seat_credential: 'msac_x0000000000000000000',
      }),
    );
  };

  it('--workspace names the agent seat folder, so an admin enrolls from their own Workspace', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-res-ws-'));
    const agent = join(root, 'scout');
    bind(agent, 'scout');
    const got = seatWorkspace({ positionals: [], flags: { workspace: agent } });
    expect(got?.dir).toBe(agent);
    expect(got?.binding && bindingSeat(got.binding)).toBe('scout');
    rmSync(root, { recursive: true, force: true });
  });

  it('a --workspace with no binding is refused, never silently skipped', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-res-ws-'));
    expect(() => seatWorkspace({ positionals: [], flags: { workspace: root } })).toThrow(
      /no musterd binding/,
    );
    rmSync(root, { recursive: true, force: true });
  });

  it('without --workspace it is the current folder, as before', () => {
    const root = mkdtempSync(join(tmpdir(), 'musterd-res-ws-'));
    bind(root, 'scout');
    const spy = vi.spyOn(process, 'cwd').mockReturnValue(root);
    expect(seatWorkspace({ positionals: [], flags: {} })?.dir).toBe(root);
    spy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });
});

describe('policyFlags (ADR 703)', () => {
  it('round-trips every knob through collectPolicyFlags', () => {
    const policy = {
      lane: 'both',
      cooldown_ms: 90_000,
      hourly_cap: 20,
      attempt_cap: 3,
      tool_policy: 'seat-policy',
      timeout_ms: 300_000,
      work_timeout_ms: 1_800_000,
      flow: 'auto',
      convene_huddles: false,
      idle_wake: true,
      max_turns: 80,
      budget_usd: 5,
      transcript_max_bytes: 262_144,
      dream_enabled: true,
      dream_nightly_wakes: 2,
      dream_budget_usd: 1.5,
    } as const;
    expect(collectPolicyFlags(parseArgs(['on', ...policyFlags(policy)]))).toEqual(policy);
  });
  it('an empty override is no flags', () => {
    expect(policyFlags({})).toEqual([]);
  });
});

describe('--idle-wake (ADR 558)', () => {
  const flags = (...argv: string[]) => collectPolicyFlags(parseArgs(['policy', ...argv]));
  it('on and off set the knob', () => {
    expect(flags('--idle-wake', 'on')).toEqual({ idle_wake: true });
    expect(flags('--idle-wake', 'off')).toEqual({ idle_wake: false });
  });
  it('refuses anything but on|off, naming the flag', () => {
    expect(() => flags('--idle-wake', 'yes')).toThrow(/--idle-wake wants on\|off/);
  });
});

describe('--convene-huddles (ADR 386)', () => {
  const flags = (...argv: string[]) => collectPolicyFlags(parseArgs(['policy', ...argv]));

  it('on and off set the knob the daemon reads', () => {
    expect(flags('--convene-huddles', 'on')).toEqual({ convene_huddles: true });
    expect(flags('--convene-huddles', 'off')).toEqual({ convene_huddles: false });
  });

  it('refuses anything but on|off, naming the flag', () => {
    expect(() => flags('--convene-huddles', 'yes')).toThrow(/--convene-huddles wants on\|off/);
  });

  it('leaves the knob out when the flag is absent, so an enroll preserves an existing override', () => {
    expect(flags('--flow', 'auto')).toEqual({ flow: 'auto' });
    expect(flags()).toBeUndefined();
  });

  it('status says a seat convenes, starred when it is the seat’s own override', () => {
    const on = ResidencyPolicySchema.parse({ convene_huddles: true });
    expect(renderPolicy(on)).toContain('convenes huddles');
    expect(renderPolicy(on, { convene_huddles: true })).toContain('convenes huddles*');
  });

  it('status names a seat that refuses being convened, and stays quiet at the default', () => {
    const off = ResidencyPolicySchema.parse({});
    expect(renderPolicy(off)).not.toContain('huddle');
    expect(renderPolicy(off, { convene_huddles: false })).toContain('refuses huddle convene*');
  });
});

describe('--dream, --dream-nightly, --dream-budget (ADR 494)', () => {
  const flags = (...argv: string[]) => collectPolicyFlags(parseArgs(['policy', ...argv]));

  it('sets the dream knobs the daemon reads', () => {
    expect(flags('--dream', 'on')).toEqual({ dream_enabled: true });
    expect(flags('--dream', 'off')).toEqual({ dream_enabled: false });
    expect(flags('--dream-nightly', '2', '--dream-budget', '1.5')).toEqual({
      dream_nightly_wakes: 2,
      dream_budget_usd: 1.5,
    });
  });

  it('refuses a bad value, naming the flag', () => {
    expect(() => flags('--dream', 'yes')).toThrow(/--dream wants on\|off/);
    expect(() => flags('--dream-budget', 'lots')).toThrow(/--dream-budget wants dollars/);
  });

  it('status says a seat dreams, and stays quiet while dreaming is off', () => {
    const on = ResidencyPolicySchema.parse({ dream_enabled: true, dream_nightly_wakes: 2 });
    expect(renderPolicy(on)).toContain('dreams 2/night');
    expect(renderPolicy(on, { dream_enabled: true })).toContain('dreams 2/night*');
    expect(renderPolicy(ResidencyPolicySchema.parse({}))).not.toContain('dream');
  });
});
