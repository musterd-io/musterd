import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containsMusterdCredential } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCatalog, originRepoName } from './catalog.js';

let home: string;
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-catalog-')));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const emptyConfig = { bindings: {}, identities: {}, knownIdentities: [] };
const binding = (team: string, name: string, extra: Record<string, unknown> = {}) => ({
  version: 2,
  server: 'http://127.0.0.1:4849',
  team,
  claim: { mode: 'seat', name },
  ...extra,
});
const provisioned = (desired: string[]) => ({
  version: 3,
  toolkit: '',
  desired,
  contributions: {},
  provisionedAt: '2026-10-01T00:00:00.000Z',
});

function seatDir(
  team: string,
  project: string,
  member: string,
  b: unknown,
  p?: unknown,
  root = join(home, 'musterd'),
): string {
  const dir = join(root, team, project, member);
  mkdirSync(join(dir, '.musterd'), { recursive: true });
  writeFileSync(
    join(dir, '.musterd', 'binding.json'),
    typeof b === 'string' ? b : JSON.stringify(b),
  );
  if (p !== undefined) writeFileSync(join(dir, '.musterd', 'provisioned.json'), JSON.stringify(p));
  return dir;
}

describe('buildCatalog (ADR 491)', () => {
  it('lists every layout Workspace with its team, project, member, harnesses and last session', () => {
    seatDir(
      'revive',
      'agents',
      'stanley',
      binding('revive', 'stanley', {
        agent_key: 'mskey_SECRET',
        session: { harness: 'claude-code', id: 'sess-SECRET-ID', started_at: 1_000 },
      }),
      provisioned(['claude-code', 'musterd']),
    );
    seatDir('revive', 'agents', 'gptbot', binding('revive', 'gptbot'), provisioned(['codex']));
    const cat = buildCatalog({ home, config: emptyConfig, now: 99 });
    expect(cat.taken_at).toBe(99);
    expect(cat.seats.map((s) => s.address)).toEqual([
      'revive/agents/gptbot',
      'revive/agents/stanley',
    ]);
    expect(cat.seats[1]).toEqual({
      address: 'revive/agents/stanley',
      team: 'revive',
      project: 'agents',
      member: 'stanley',
      server: 'http://127.0.0.1:4849',
      path: join(home, 'musterd', 'revive', 'agents', 'stanley'),
      kind: 'agent',
      harnesses: ['claude-code', 'musterd'],
      remote: null,
      last_session: { harness: 'claude-code', started_at: 1_000, ended_at: null },
      problem: null,
    });
    expect(cat.teams).toEqual([{ team: 'revive', here: true }]);
  });

  it('carries no secret and no session id — the snapshot is written to disk', () => {
    seatDir(
      'revive',
      'agents',
      'dolly',
      binding('revive', 'dolly', {
        agent_key: 'mskey_a1',
        grant: 'msgr_b2',
        seat_credential: 'msac_c3',
        session_lease: 'msls_d4',
        session: { harness: 'codex', id: 'sess-zzz', started_at: 1 },
      }),
    );
    const text = JSON.stringify(buildCatalog({ home, config: emptyConfig }));
    expect(containsMusterdCredential(text)).toBe(false);
    expect(text).not.toContain('sess-zzz');
  });

  it('reads a human seat from its credential prefix, without copying it', () => {
    seatDir('revive', 'agents', 'nick', binding('revive', 'nick', { agent_key: 'mscr_human' }));
    const [nick] = buildCatalog({ home, config: emptyConfig }).seats;
    expect(nick?.kind).toBe('human');
  });

  it('flags a broken Workspace with the exact fix instead of dropping it', () => {
    const legacy = seatDir('revive', 'agents', 'old', {
      server: 'http://127.0.0.1:4849',
      team: 'revive',
      surface: 'claude-code',
      claim: { mode: 'seat', name: 'old' },
    });
    const broken = seatDir('revive', 'agents', 'bad', '{not json');
    const v2 = seatDir('revive', 'agents', 'mid', binding('revive', 'mid'), {
      version: 2,
      profile: '',
      desired: ['claude-code'],
      contributions: {},
      provisionedAt: 'x',
    });
    const byMember = new Map(
      buildCatalog({ home, config: emptyConfig }).seats.map((s) => [s.member, s]),
    );
    expect(byMember.get('old')?.problem).toEqual({
      kind: 'binding-legacy',
      fix: `cd ${legacy} && musterd harness configure`,
    });
    expect(byMember.get('bad')?.problem).toEqual({
      kind: 'binding-invalid',
      fix: `cd ${broken} && musterd init --check`,
    });
    expect(byMember.get('mid')?.problem?.kind).toBe('provisioning-legacy');
    expect(byMember.get('mid')?.problem?.fix).toBe(`cd ${v2} && musterd harness configure`);
  });

  it('adds registry Workspaces outside the layout and counts entries whose folder is gone', () => {
    const outside = seatDir(
      'x',
      'y',
      'ext',
      binding('dawn', 'ext'),
      undefined,
      join(home, 'elsewhere'),
    );
    const gone = join(home, 'deleted', 'seat');
    const cat = buildCatalog({
      home,
      config: {
        ...emptyConfig,
        bindings: {
          [outside]: { team: 'dawn', seat: 'ext' },
          [gone]: { team: 'dawn', seat: 'gone' },
        },
      },
    });
    expect(cat.seats.map((s) => s.address)).toEqual(['dawn/y/ext']);
    expect(cat.stale).toEqual([gone]);
  });

  it('host-qualifies one address served by two servers', () => {
    seatDir('revive', 'agents', 'stanley', binding('revive', 'stanley'));
    seatDir(
      'revive',
      'agents',
      'stanley',
      { ...binding('revive', 'stanley'), server: 'https://musterd.io' },
      undefined,
      join(home, 'elsewhere'),
    );
    const outside = join(home, 'elsewhere', 'revive', 'agents', 'stanley');
    const cat = buildCatalog({
      home,
      config: { ...emptyConfig, bindings: { [outside]: { team: 'revive', seat: 'stanley' } } },
    });
    expect(cat.seats.map((s) => s.address).sort()).toEqual([
      'revive@127.0.0.1:4849/agents/stanley',
      'revive@musterd.io/agents/stanley',
    ]);
  });

  it('lists a team this machine holds an identity for, even with no Workspace here', () => {
    const cat = buildCatalog({
      home,
      config: {
        ...emptyConfig,
        identities: { acme: { name: 'nick', key: 'mscr_x', surface: 'cli' } },
      },
    });
    expect(cat.teams).toEqual([{ team: 'acme', here: false }]);
    expect(JSON.stringify(cat)).not.toContain('mscr_x');
  });

  it('reads the origin remote name from git files, without a subprocess', () => {
    const repo = join(home, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Org/musterd.git'], {
      cwd: repo,
    });
    expect(originRepoName(repo)).toBe('musterd');
    expect(originRepoName(join(home, 'nope'))).toBeNull();
  });
});
