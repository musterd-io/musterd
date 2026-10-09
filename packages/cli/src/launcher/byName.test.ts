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

  it('a live seat that is a wake says so and why, on a TTY and off one (ADR 543)', async () => {
    const woken = async () =>
      [
        {
          id: 'm',
          team: 'revive',
          name: 'stanley',
          kind: 'agent',
          created_at: 1,
          presence: 'online',
          roles: [],
          role: '',
          lifecycle: 'forever',
          presences: [
            {
              surface: 'claude-code',
              status: 'online',
              last_seen_at: 1,
              attached_at: 1,
              provenance: 'wake',
              wake_for: {
                edge: 'dispatch_continuation',
                lane_id: '01M46YWG8YHEV2SKW9F1N0W8FG',
                act_id: null,
                act: null,
                from: null,
              },
            },
          ],
        },
      ] as never;
    const confirm = vi.fn(async () => false);
    const cat = catalog(seat('revive/agents/stanley', { server: 'http://127.0.0.1:4849' }));
    const { d } = deps({ roster: woken, isTTY: true, confirm, catalog: cat });
    expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
    expect(confirm.mock.calls[0]?.[0]).toMatch(
      /^stanley is live here \(claude-code\).* — a wake: musterd started it headless to carry on with lane 01M46YWG8Y\. That's expected; .* replaces it within seconds .* Open one anyway\? \(y\/N\) $/,
    );
    const off = deps({ roster: woken, isTTY: false, catalog: cat });
    await expect(launchByName('stanley', parseArgs([]), off.d)).rejects.toMatchObject({
      exitCode: 1,
      message: expect.stringMatching(/a wake to carry on with lane 01M46YWG8Y — pass --force/),
    });
  });

  describe('a live local wake (ADR 546)', () => {
    const woken = async () =>
      [
        {
          id: 'm',
          team: 'revive',
          name: 'stanley',
          kind: 'agent',
          created_at: 1,
          presence: 'online',
          roles: [],
          role: '',
          lifecycle: 'forever',
          presences: [
            {
              surface: 'claude-code',
              status: 'online',
              last_seen_at: 1,
              attached_at: 1,
              provenance: 'wake',
              wake_for: {
                edge: 'dispatch_continuation',
                lane_id: '01M46YWG8YHEV2SKW9F1N0W8FG',
                act_id: null,
                act: null,
                from: null,
              },
            },
          ],
        },
      ] as never;
    // Built per call: `dir` is made in beforeEach, after this describe body runs.
    const cat = (): Catalog =>
      catalog(seat('revive/agents/stanley', { server: 'http://127.0.0.1:4849', kind: 'agent' }))();
    const found = (over: object = {}) =>
      vi.fn(() => ({
        lease_id: 'L1',
        pid: 77,
        session_id: 'S-1',
        harness: 'claude-code',
        started_at: 1,
        workspace: dir,
        ...over,
      }));
    function setup(over: Partial<LaunchDeps> = {}) {
      const planned: Array<{ session: unknown; mode: string; harness: unknown }> = [];
      const stop = vi.fn(async () => 'yielded' as const);
      const made = deps({
        roster: woken,
        catalog: cat,
        localWake: found() as never,
        stopWake: stop,
        plan: (async (i: { session: unknown; mode: string; harness: unknown }) => {
          planned.push({ session: i.session, mode: i.mode, harness: i.harness });
          return { bin: 'claude', args: ['--resume'], cwd: dir, harness: 'claude-code' };
        }) as never,
        mirror: async () => ({ added: [], unchanged: [], skipped: [] }) as never,
        ...over,
      });
      return { ...made, planned, stop };
    }

    it('⏎ stops the wake and resumes ITS conversation, telling the session why', async () => {
      const { d, supervise, planned, stop } = setup({
        isTTY: true,
        choose: async () => 'take-over',
      });
      expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
      expect(stop).toHaveBeenCalledWith(
        expect.objectContaining({ lease_id: 'L1', pid: 77 }),
        expect.any(String),
      );
      expect(planned).toEqual([
        { session: { harness: 'claude-code', id: 'S-1' }, mode: 'resume', harness: 'claude-code' },
      ]);
      const plan = (supervise.mock.calls[0] as unknown as [{ env?: NodeJS.ProcessEnv }])[0];
      expect(plan.env).toMatchObject({ MUSTERD_TOOK_OVER: 'to carry on with lane 01M46YWG8Y' });
    });

    it('esc stops nothing and launches nothing', async () => {
      const { d, supervise, stop } = setup({ isTTY: true, choose: async () => 'cancel' });
      expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
      expect(stop).not.toHaveBeenCalled();
      expect(supervise).not.toHaveBeenCalled();
    });

    it('--take-over and --force take over without a TTY', async () => {
      for (const flag of ['--take-over', '--force']) {
        const { d, supervise, stop } = setup({ isTTY: false });
        expect(await launchByName('stanley', parseArgs([flag]), d)).toBe(0);
        expect(stop).toHaveBeenCalledTimes(1);
        expect(supervise).toHaveBeenCalledTimes(1);
      }
    });

    it('with no TTY and no flag, the refusal names --take-over and --watch', async () => {
      const { d, stop } = setup({ isTTY: false });
      await expect(launchByName('stanley', parseArgs([]), d)).rejects.toMatchObject({
        exitCode: 1,
        message: expect.stringMatching(/--take-over .*--watch/),
      });
      expect(stop).not.toHaveBeenCalled();
    });

    it('watch that ends because the wake finished resumes without stopping anything', async () => {
      const { d, supervise, stop } = setup({
        isTTY: true,
        choose: async () => 'watch',
        watch: async () => 'finished',
      });
      expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
      expect(stop).not.toHaveBeenCalled();
      expect(supervise).toHaveBeenCalledTimes(1);
    });

    it('watch left with esc launches nothing; ⏎ inside watch takes over', async () => {
      const left = setup({ isTTY: true, choose: async () => 'watch', watch: async () => 'leave' });
      expect(await launchByName('stanley', parseArgs([]), left.d)).toBe(0);
      expect(left.supervise).not.toHaveBeenCalled();
      const took = setup({
        isTTY: true,
        choose: async () => 'watch',
        watch: async () => 'take-over',
      });
      expect(await launchByName('stanley', parseArgs([]), took.d)).toBe(0);
      expect(took.stop).toHaveBeenCalledTimes(1);
      expect(took.supervise).toHaveBeenCalledTimes(1);
    });

    it('a native wake (in process) is stopped, then the person gets a FRESH session — nothing to resume', async () => {
      const { d, supervise, planned, stop } = setup({
        isTTY: true,
        choose: async () => 'take-over',
        localWake: found({ session_id: null, harness: 'musterd', in_process: true }) as never,
      });
      expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
      expect(stop).toHaveBeenCalledWith(
        expect.objectContaining({ lease_id: 'L1', in_process: true }),
        expect.any(String),
      );
      expect(planned).toEqual([{ session: null, mode: 'fresh', harness: null }]);
      const plan = (supervise.mock.calls[0] as unknown as [{ env?: NodeJS.ProcessEnv }])[0];
      expect(plan.env).toMatchObject({ MUSTERD_TOOK_OVER: expect.any(String) });
    });

    it('a native wake that will not stop launches nothing — no second session beside a running loop', async () => {
      const { d, supervise } = setup({
        isTTY: true,
        choose: async () => 'take-over',
        localWake: found({ session_id: null, harness: 'musterd', in_process: true }) as never,
        stopWake: vi.fn(async () => 'stuck' as const),
      });
      await expect(launchByName('stanley', parseArgs([]), d)).rejects.toThrow(
        /did not stop in time/,
      );
      expect(supervise).not.toHaveBeenCalled();
    });

    it('a wake file with no session id (an older host) falls back to the plain question', async () => {
      const confirm = vi.fn(async () => false);
      const choose = vi.fn(async () => 'take-over' as const);
      const { d, stop } = setup({
        isTTY: true,
        confirm,
        choose,
        localWake: found({ session_id: null }) as never,
      });
      expect(await launchByName('stanley', parseArgs([]), d)).toBe(0);
      expect(choose).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(confirm.mock.calls[0]?.[0]).toMatch(/Open one anyway\? \(y\/N\) $/);
    });
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

describe('`musterd <seat>` for a folder here whose seat lives elsewhere (ADR 503 follow-up)', () => {
  it('refuses with the move ceremony instead of launching', async () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'launcher.json'),
      JSON.stringify({
        version: 1,
        last: null,
        seats: {},
        snapshot: {
          taken_at: 1,
          seats: [],
          teams: [],
          members: [
            {
              team: 'revive',
              member: 'stanley',
              kind: 'agent',
              address: 'revive/agents/stanley',
              where: 'node',
              node: 'n-air',
              where_label: 'air-2',
              can: 'none',
            },
          ],
        },
      }),
    );
    const { d, supervise } = deps();
    await expect(launchByName('stanley', parseArgs([]), d)).rejects.toMatchObject({
      exitCode: 1,
      message:
        'revive/agents/stanley is resident on air-2 — move it: musterd residency off + node unbind there',
    });
    expect(supervise).not.toHaveBeenCalled();
  });
});
