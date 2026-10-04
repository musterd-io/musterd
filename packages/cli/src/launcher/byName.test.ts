import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { launchByName, launchSeat, type LaunchDeps } from './byName.js';
import type { Catalog } from './catalog.js';
import type { Seat } from './store.js';

let dir: string;
let env: NodeJS.ProcessEnv;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'musterd-byname-'));
  env = { ...process.env, MUSTERD_CONFIG: join(dir, 'config.json') };
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const seat = (address: string, over: Partial<Seat> = {}): Seat => {
  const [team, project, member] = address.split('/') as [string, string, string];
  return {
    address,
    team,
    project,
    member,
    server: 'http://127.0.0.1:9',
    path: dir,
    kind: 'human', // a login shell: planLaunch needs no adapter registry for it
    harnesses: [],
    remote: null,
    last_session: null,
    problem: null,
    ...over,
  };
};
const catalog =
  (...seats: Seat[]): (() => Catalog) =>
  () => ({ taken_at: 0, seats, teams: [], stale: [] });

function deps(over: Partial<LaunchDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const supervise = vi.fn(async () => ({ code: 0, durationMs: 1_500 }));
  const d: LaunchDeps = {
    catalog: catalog(
      seat('revive/agents/stanley'),
      seat('revive/agents/miley'),
      seat('revive/site/miley'),
    ),
    roster: async () => null,
    supervise,
    isTTY: false,
    out: (s) => out.push(s),
    err: (s) => err.push(s),
    env,
    now: () => 10_000,
    ...over,
  };
  return { d, out, err, supervise };
}

describe('launchByName (ADR 491 Decision 2)', () => {
  it('a flag-shaped word stays an unknown command, as today', async () => {
    const { d } = deps();
    await expect(launchByName('--json', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringMatching(/^unknown command "--json".*musterd help$/),
    });
  });

  it('no match is an unknown command, suggesting a near command first, then a near seat', async () => {
    const { d } = deps();
    await expect(launchByName('statuss', parseArgs([]), d)).rejects.toThrow(
      /did you mean "status"\?/,
    );
    await expect(launchByName('stanly', parseArgs([]), d)).rejects.toThrow(
      /did you mean the seat "stanley"\?/,
    );
  });

  it('an ambiguous name without a TTY exits 2 and lists every address', async () => {
    const { d } = deps();
    await expect(launchByName('miley', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('musterd revive/agents/miley'),
    });
  });

  it('--path prints the Workspace and launches nothing', async () => {
    const { d, out, supervise } = deps();
    expect(await launchByName('stanley', parseArgs(['--path']), d)).toBe(0);
    expect(out).toEqual([`${dir}\n`]);
    expect(supervise).not.toHaveBeenCalled();
  });

  it('launches, records recents, prints the receipt, returns the harness code', async () => {
    const { d, err, supervise } = deps();
    supervise.mockResolvedValueOnce({ code: 7, durationMs: 9_000 });
    expect(await launchByName('stanley', parseArgs([]), d)).toBe(7);
    expect(err).toEqual(['✗ stanley · shell · 9s · exit 7 · musterd - to go back\n']);
    const file = JSON.parse(readFileSync(join(dir, 'launcher.json'), 'utf8'));
    expect(file.last).toBe('revive/agents/stanley');
    expect(file.seats['revive/agents/stanley']).toMatchObject({
      harness: 'shell',
      mode: 'fresh',
      exit: 7,
    });
  });

  it('`-` relaunches the last seat; `-r` resumes', async () => {
    const { d, supervise } = deps();
    await launchByName('stanley', parseArgs([]), d);
    await launchByName('-', parseArgs(['-r']), d);
    const file = JSON.parse(readFileSync(join(dir, 'launcher.json'), 'utf8'));
    expect(file.seats['revive/agents/stanley'].mode).toBe('resume');
    expect(supervise).toHaveBeenCalledTimes(2);
  });

  it('`-` with nothing launched yet says so', async () => {
    const { d } = deps();
    await expect(launchByName('-', parseArgs([]), d)).rejects.toThrow(/no seat launched yet/);
  });

  it('refuses a seat that needs repair, with the fix', async () => {
    const broken = seat('revive/agents/old', {
      problem: { kind: 'binding-legacy', fix: 'cd /w && musterd harness configure' },
    });
    const { d, supervise } = deps({ catalog: catalog(broken) });
    await expect(launchByName('old', parseArgs([]), d)).rejects.toThrow(
      /needs repair — cd \/w && musterd harness configure/,
    );
    expect(supervise).not.toHaveBeenCalled();
  });

  it('a live seat is refused without a TTY unless --force', async () => {
    const live = async () =>
      [
        {
          id: 'm',
          team: 'revive',
          name: 'stanley',
          kind: 'human',
          created_at: 1,
          presence: 'online',
          roles: [],
          role: '',
          lifecycle: 'forever',
          presences: [
            { surface: 'claude-code', status: 'online', last_seen_at: 1, attached_at: 1 },
          ],
        },
      ] as never;
    const { d, supervise } = deps({
      roster: live,
      catalog: catalog(seat('revive/agents/stanley', { server: 'http://127.0.0.1:4849' })),
    });
    await expect(launchByName('stanley', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/live here.*--force/),
    });
    expect(await launchByName('stanley', parseArgs(['--force']), d)).toBe(0);
    expect(supervise).toHaveBeenCalledTimes(1);
  });

  it('a live seat on a TTY asks, and N launches nothing', async () => {
    const live = async () =>
      [
        {
          id: 'm',
          team: 'revive',
          name: 'stanley',
          kind: 'human',
          created_at: 1,
          presence: 'online',
          roles: [],
          role: '',
          lifecycle: 'forever',
          presences: [
            { surface: 'claude-code', status: 'online', last_seen_at: 1, attached_at: 1 },
          ],
        },
      ] as never;
    const confirm = vi.fn(async () => false);
    const { d, supervise } = deps({
      roster: live,
      isTTY: true,
      confirm,
      catalog: catalog(seat('revive/agents/stanley', { server: 'http://127.0.0.1:4849' })),
    });
    expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
    expect(confirm.mock.calls[0]?.[0]).toMatch(
      /^stanley is live here \(claude-code\).*Open a second session in the same folder\? \(y\/N\) $/,
    );
    expect(supervise).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'launcher.json'))).toBe(false);
  });

  it('an ambiguous name with --path refuses instead of opening the picker (review)', async () => {
    const picker = vi.fn(async () => 0);
    const { d } = deps({ isTTY: true, picker });
    await expect(launchByName('miley', parseArgs(['--path']), d)).rejects.toMatchObject({
      exitCode: 2,
    });
    expect(picker).not.toHaveBeenCalled();
  });

  it('an ambiguous name on a TTY carries -r, --harness and --force into the picker (review)', async () => {
    const picker = vi.fn(async () => 0);
    const { d } = deps({ isTTY: true, picker });
    await launchByName('miley', parseArgs(['-r', '--harness', 'codex', '--force']), d);
    expect(picker).toHaveBeenCalledWith({
      query: 'miley',
      defaults: { mode: 'resume', harness: 'codex', force: true },
    });
  });

  it('refuses a seat whose folder is gone, before recording or spawning (review: stale snapshot)', async () => {
    const { d, supervise } = deps();
    await expect(
      launchSeat(
        seat('revive/agents/gone', { path: join(dir, 'no-such-folder') }),
        { mode: 'fresh', harness: null, force: true },
        d,
      ),
    ).rejects.toThrow(/folder is gone/);
    expect(supervise).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'launcher.json'))).toBe(false);
  });
});

describe('`musterd <member>` for a seat with no Workspace here (ADR 503 Decision 3)', () => {
  const entry = (member: string, over: Record<string, unknown>) => ({
    team: 'revive',
    member,
    kind: 'agent',
    address: null,
    where: 'node',
    node: 'n-air',
    where_label: 'air-2',
    can: 'none',
    ...over,
  });
  function snapshotWith(members: unknown[]) {
    const launcher = {
      version: 1,
      last: null,
      seats: {},
      snapshot: { taken_at: 1, seats: [], teams: [{ team: 'revive', here: true }], members },
    };
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'launcher.json'), JSON.stringify(launcher));
  }

  it('a wake row rings the doorbell through the same path as the picker', async () => {
    snapshotWith([entry('bo', { can: 'wake' })]);
    const wake = vi.fn(async () => 0);
    const { d } = deps({ wake, catalog: catalog(seat('revive/agents/nick')) });
    expect(await launchByName('bo', parseArgs([]), d)).toBe(0);
    expect(wake).toHaveBeenCalledWith(
      expect.objectContaining({ member: 'bo', can: 'wake' }),
      expect.any(Array),
      'nick',
      expect.anything(),
    );
  });

  it('a none row names where the seat is and the move ceremony — never a setup', async () => {
    snapshotWith([entry('cy', {})]);
    const { d } = deps({ catalog: catalog(seat('revive/agents/nick')) });
    await expect(launchByName('cy', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining(
        'resident on air-2 — move it: musterd residency off + node unbind there',
      ),
    });
  });

  it('a setup row points at the picker', async () => {
    snapshotWith([
      entry('slate', { where: 'nowhere', node: null, where_label: null, can: 'setup' }),
    ]);
    const { d } = deps({ catalog: catalog(seat('revive/agents/nick')) });
    await expect(launchByName('slate', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringContaining('set it up from the picker: musterd'),
    });
  });
});
