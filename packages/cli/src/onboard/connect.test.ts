import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { connectRepos, resultLine, seatNameFor, type ConnectReposInput } from './connect.js';

type Row = { harness: string; result: string; detail?: string };
const seat = (dir: string, rows: Row[], ok = true) => ({
  workspace: { dir, kind: 'here' as const, created: false },
  reused: false,
  granted: true,
  wiring: { ok, results: rows },
  wiringError: null,
  seatFileUnpublished: null,
});
// One harness writes several fragments; the engine's own musterd-core guidance rides along too.
const wiredRows: Row[] = [
  { harness: 'claude-code', result: 'applied' },
  { harness: 'claude-code', result: 'unchanged' },
  { harness: 'cursor', result: 'unchanged' },
  { harness: 'musterd-core', result: 'applied' },
];
const okProvision = () =>
  vi.fn(async (i: { sourceDir: string }) => seat(i.sourceDir, wiredRows)) as unknown as NonNullable<
    ConnectReposInput['provision']
  > & { mock: { calls: [Record<string, unknown>][] } };

const base = {
  excludeCredential: () => true,
  desired: ['claude-code', 'cursor'],
  team: 'revive',
  server: 'http://x',
  http: {} as ConnectReposInput['http'],
  roster: [] as string[],
};

describe('seatNameFor', () => {
  it('uses the folder name, cleaned', () => {
    expect(seatNameFor('/code/My Repo', [])).toBe('my-repo');
    expect(seatNameFor('/code/api/', [])).toBe('api');
    expect(seatNameFor('/', [])).toBe('agent');
  });

  it('suffixes a taken name, case-insensitively', () => {
    expect(seatNameFor('/code/web', ['Web'])).toBe('web-2');
    expect(seatNameFor('/code/web', ['web', 'web-2'])).toBe('web-3');
  });
});

describe('connectRepos', () => {
  it('gives three repos three seats bound in place with the same desired set', async () => {
    const provision = okProvision();
    const writePrimer = vi.fn();
    const got = await connectRepos({
      ...base,
      repos: ['/c/api', '/c/web', '/c/infra'],
      provision,
      writePrimer,
    });
    expect(got.map((r) => [r.name, r.status])).toEqual([
      ['api', 'ok'],
      ['web', 'ok'],
      ['infra', 'ok'],
    ]);
    for (const [call] of provision.mock.calls) {
      expect(call).toMatchObject({
        here: true,
        gitIdentity: false,
        harnesses: ['claude-code', 'cursor'],
        toolkit: '',
        team: 'revive',
      });
    }
    expect(provision.mock.calls.map(([c]) => c['sourceDir'])).toEqual([
      '/c/api',
      '/c/web',
      '/c/infra',
    ]);
    expect(writePrimer).toHaveBeenCalledTimes(3);
    expect(got[0]!.wired).toEqual(['claude-code', 'cursor']);
  });

  it('names two same-named repos web and web-2, around names already on the roster', async () => {
    const got = await connectRepos({
      ...base,
      roster: ['api'],
      repos: ['/a/web', '/b/web', '/c/api'],
      provision: okProvision(),
      writePrimer: () => {},
    });
    expect(got.map((r) => r.name)).toEqual(['web', 'web-2', 'api-2']);
  });

  it('a failing repo leaves the others connected', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) => {
      if (i.sourceDir === '/c/web') throw new Error('mint refused');
      return seat(i.sourceDir, wiredRows);
    }) as unknown as NonNullable<ConnectReposInput['provision']>;
    const writePrimer = vi.fn();
    const got = await connectRepos({
      ...base,
      repos: ['/c/api', '/c/web', '/c/infra'],
      provision,
      writePrimer,
    });
    expect(got.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(got[1]!.detail).toBe('mint refused');
    expect(writePrimer).toHaveBeenCalledTimes(2);
  });

  it('partial wiring keeps the seat and says which harness', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) =>
      seat(
        i.sourceDir,
        [
          { harness: 'claude-code', result: 'applied' },
          { harness: 'cursor', result: 'applied' },
          { harness: 'cursor', result: 'conflict', detail: 'mcp.json unreadable' },
        ],
        false,
      ),
    ) as unknown as NonNullable<ConnectReposInput['provision']>;
    const [r] = await connectRepos({
      ...base,
      repos: ['/c/web'],
      provision,
      writePrimer: () => {},
    });
    expect(r).toMatchObject({
      status: 'partial',
      wired: ['claude-code'],
      detail: 'cursor: mcp.json unreadable',
    });
  });

  it('a selected harness not installed here is pending, not a failure', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) =>
      seat(i.sourceDir, [
        { harness: 'claude-code', result: 'applied' },
        { harness: 'cursor', result: 'pending' },
      ]),
    ) as unknown as NonNullable<ConnectReposInput['provision']>;
    const [r] = await connectRepos({
      ...base,
      repos: ['/c/web'],
      provision,
      writePrimer: () => {},
    });
    expect(r).toMatchObject({ status: 'ok', wired: ['claude-code'], detail: null });
  });

  it('a wiring error after binding is partial', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) => ({
      ...seat(i.sourceDir, []),
      wiring: null,
      wiringError: 'reconcile threw',
    })) as unknown as NonNullable<ConnectReposInput['provision']>;
    const [r] = await connectRepos({
      ...base,
      repos: ['/c/web'],
      provision,
      writePrimer: () => {},
    });
    expect(r).toMatchObject({ status: 'partial', detail: 'reconcile threw' });
  });

  it('ignores the credential-holding binding before provisioning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules\n');
    const provision = vi.fn(async (i: { sourceDir: string }) => {
      expect(readFileSync(join(i.sourceDir, '.gitignore'), 'utf8')).toContain(
        '.musterd/binding.json',
      );
      return seat(i.sourceDir, wiredRows);
    }) as unknown as NonNullable<ConnectReposInput['provision']>;
    const [r] = await connectRepos({
      ...base,
      excludeCredential: undefined,
      repos: [dir],
      provision,
      writePrimer: () => {},
    });
    expect(r!.status).toBe('ok');
    expect(readFileSync(join(dir, '.gitignore'), 'utf8').startsWith('node_modules\n')).toBe(true);
  });

  it('says so when the binding could not be ignored', async () => {
    const [r] = await connectRepos({
      ...base,
      repos: ['/c/web'],
      provision: okProvision(),
      writePrimer: () => {},
      excludeCredential: () => false,
    });
    expect(r).toMatchObject({ status: 'partial' });
    expect(r!.detail).toContain("don't commit it");
  });

  it('appends the primer to an existing AGENTS.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-'));
    writeFileSync(join(dir, 'AGENTS.md'), '# Mine\n');
    await connectRepos({ ...base, repos: [dir], provision: okProvision() });
    const body = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(body.startsWith('# Mine\n')).toBe(true);
    expect(body).toContain('musterd');
  });
});

describe('resultLine', () => {
  const labels = { 'claude-code': 'Claude Code', cursor: 'Cursor' };
  const r = { dir: '/c/web', name: 'web' };
  it('renders ok, partial and failed', () => {
    expect(
      resultLine({ ...r, status: 'ok', wired: ['claude-code', 'cursor'], detail: null }, labels),
    ).toContain('web — Claude Code, Cursor');
    expect(
      resultLine({ ...r, status: 'partial', wired: ['claude-code'], detail: 'cursor: x' }, labels),
    ).toContain('cursor: x; run musterd wire there');
    expect(resultLine({ ...r, status: 'failed', wired: [], detail: 'boom' }, labels)).toContain(
      'web — boom',
    );
  });
});
