import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { launchByName, type LaunchDeps } from './byName.js';
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
});
