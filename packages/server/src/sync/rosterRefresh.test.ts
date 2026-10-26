import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Ctx } from '../context.js';
import { log } from '../log.js';
import {
  describeSeatFileReach,
  makeRosterPullTick,
  makeUnresolvedSeatHook,
  refreshRosterRoot,
  resetRosterRefreshAttempts,
  ROSTER_REFRESH_MIN_INTERVAL_MS,
  type RosterRefreshOutcome,
  type SeatFileReach,
  seatFileReach,
} from './rosterRefresh.js';

/**
 * ADR 592: a daemon whose fold stops on an unknown seat pulls its roster repo itself. The git half
 * runs against a real bare remote and two clones — the shape of a hub and a joiner sharing one
 * roster repo — because what matters is what `git pull --ff-only` does, not what we think it does.
 */
describe('refreshRosterRoot — fast-forward a roster root from its upstream (ADR 592)', () => {
  let root: string;
  let remote: string;
  let a: string;
  let b: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  const identify = (cwd: string) => {
    git(cwd, 'config', 'user.email', 't@t');
    git(cwd, 'config', 'user.name', 't');
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-rosterrefresh-'));
    remote = join(root, 'remote.git');
    a = join(root, 'a');
    b = join(root, 'b');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '--quiet', remote, a]);
    identify(a);
    writeFileSync(join(a, 'team.toml'), 'slug = "bravo"\n');
    git(a, 'add', '.');
    git(a, 'commit', '-q', '-m', 'team');
    git(a, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '--quiet', remote, b]);
    identify(b);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('updated when the remote moved, current when it did not', async () => {
    writeFileSync(join(a, 'resident.toml'), 'kind = "agent"\n');
    git(a, 'add', '.');
    git(a, 'commit', '-q', '-m', 'add resident');
    git(a, 'push', '-q');
    expect(await refreshRosterRoot(b)).toEqual({ root: b, outcome: 'updated' });
    expect(git(b, 'log', '-1', '--format=%s')).toBe('add resident');
    expect(await refreshRosterRoot(b)).toEqual({ root: b, outcome: 'current' });
  });

  it('skipped outside a checkout and on a branch with no upstream', async () => {
    const plain = join(root, 'plain');
    execFileSync('mkdir', ['-p', plain]);
    expect((await refreshRosterRoot(plain)).outcome).toBe('skipped');
    const lone = join(root, 'lone');
    execFileSync('git', ['init', '--quiet', '-b', 'main', lone]);
    expect(await refreshRosterRoot(lone)).toMatchObject({
      outcome: 'skipped',
      detail: 'no upstream branch to pull from',
    });
  });

  it('failed, with what git said, when the root cannot fast-forward — the daemon never merges', async () => {
    writeFileSync(join(a, 'resident.toml'), 'kind = "agent"\n');
    git(a, 'add', '.');
    git(a, 'commit', '-q', '-m', 'add resident on a');
    git(a, 'push', '-q');
    writeFileSync(join(b, 'resident.toml'), 'kind = "agent"\nrole = "worker"\n');
    git(b, 'add', '.');
    git(b, 'commit', '-q', '-m', 'add resident on b');
    const r = await refreshRosterRoot(b);
    expect(r.outcome).toBe('failed');
    expect(r.detail).toMatch(/fast-forward|diverg/i);
    // b's own commit is untouched: nothing was merged, rebased or reset.
    expect(git(b, 'log', '-1', '--format=%s')).toBe('add resident on b');
  });
});

describe('seatFileReach — which publishing step a joiner is missing (lane 01M4S7N1HV)', () => {
  let root: string;
  let remote: string;
  let home: string;
  const rel = join('.musterd', 'seats', 'tj.toml');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-seatreach-'));
    remote = join(root, 'remote.git');
    home = join(root, 'home');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '--quiet', remote, home]);
    git(home, 'config', 'user.email', 't@t');
    git(home, 'config', 'user.name', 't');
    mkdirSync(join(home, '.musterd', 'seats'), { recursive: true });
    writeFileSync(join(home, '.musterd', 'team.toml'), 'slug = "bravo"\n');
    git(home, 'add', '.');
    git(home, 'commit', '-q', '-m', 'team');
    git(home, 'push', '-q', '-u', 'origin', 'main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('walks missing → uncommitted → unpushed → pushed as the joiner publishes', async () => {
    expect(await seatFileReach([home], 'tj')).toEqual({ state: 'missing' });
    expect(await seatFileReach([], 'tj')).toEqual({ state: 'missing' });
    // TJ's state on 2026-10-12: the file was written and never added.
    writeFileSync(join(home, rel), 'kind = "agent"\n');
    expect(await seatFileReach([home], 'tj')).toEqual({ state: 'uncommitted', root: home });
    git(home, 'add', rel);
    expect(await seatFileReach([home], 'tj')).toEqual({ state: 'uncommitted', root: home });
    git(home, 'commit', '-q', '-m', 'roster: add tj');
    expect(await seatFileReach([home], 'tj')).toEqual({ state: 'unpushed', root: home });
    git(home, 'push', '-q');
    expect(await seatFileReach([home], 'tj')).toEqual({ state: 'pushed', root: home });
  });

  it('picks the root that holds the file, and says unknown outside a git checkout', async () => {
    const plain = join(root, 'plain');
    mkdirSync(join(plain, '.musterd', 'seats'), { recursive: true });
    writeFileSync(join(plain, rel), 'kind = "agent"\n');
    expect(await seatFileReach([plain], 'tj')).toEqual({ state: 'unknown', root: plain });
    writeFileSync(join(home, rel), 'kind = "agent"\n');
    expect(await seatFileReach([join(root, 'nowhere'), home], 'tj')).toEqual({
      state: 'uncommitted',
      root: home,
    });
  });

  it('each state names its fix; only `pushed` says to retry', () => {
    const say = (state: SeatFileReach['state']) =>
      describeSeatFileReach('tj', { state, ...(state === 'missing' ? {} : { root: '/r' }) });
    expect(say('missing')).toContain('musterd team add tj --kind agent');
    expect(say('uncommitted')).toContain(
      'git -C /r add .musterd/seats/tj.toml && git -C /r commit -m "roster: add tj" && git -C /r push',
    );
    expect(say('unpushed')).toContain('git -C /r push');
    expect(say('pushed')).toMatch(/retry in a minute/);
    for (const s of ['missing', 'uncommitted', 'unpushed', 'unknown'] as const)
      expect(say(s)).not.toMatch(/retry in/);
    expect(say('uncommitted')).toContain('no retry can work');
  });
});

describe('makeUnresolvedSeatHook — the puller’s hook (ADR 592)', () => {
  const ctxFor = (roots: string[]) =>
    ({ config: {}, rosterRoots: roots, db: {}, hub: {} }) as unknown as Ctx;

  it('answers false at once with no roster roots and never pulls', async () => {
    let pulled = 0;
    const hook = makeUnresolvedSeatHook(ctxFor([]), {
      refresh: async () => {
        pulled++;
        return [];
      },
    });
    expect(await hook({ id: 't', slug: 'bravo' }, 'late')).toBe(false);
    expect(pulled).toBe(0);
  });

  it('pulls, reconciles when something moved, and rate-limits the same stop to once a minute', async () => {
    const ctx = ctxFor(['/roster']);
    resetRosterRefreshAttempts(ctx.config);
    let clock = 1_000_000;
    const calls: string[] = [];
    let next: RosterRefreshOutcome['outcome'] = 'updated';
    const hook = makeUnresolvedSeatHook(ctx, {
      refresh: async (roots) => {
        calls.push(`refresh:${roots.join(',')}`);
        return [{ root: roots[0]!, outcome: next }];
      },
      reconcile: async () => {
        calls.push('reconcile');
      },
      now: () => clock,
    });
    const team = { id: 't', slug: 'bravo' };
    expect(await hook(team, 'late')).toBe(true);
    expect(calls).toEqual(['refresh:/roster', 'reconcile']);
    // The same stop a tick later: inside the minute, no git call.
    clock += 1_000;
    expect(await hook(team, 'late')).toBe(false);
    expect(calls).toHaveLength(2);
    // A different seat is a different stop: it pulls now.
    next = 'current';
    expect(await hook(team, 'other')).toBe(false);
    expect(calls).toEqual(['refresh:/roster', 'reconcile', 'refresh:/roster']);
    // The first stop again, past the minute: pulls, and `current` means nothing to re-fold.
    clock += ROSTER_REFRESH_MIN_INTERVAL_MS;
    expect(await hook(team, 'late')).toBe(false);
    expect(calls).toHaveLength(4);
  });

  it('a failed pull answers false and leaves the stop to stand', async () => {
    const ctx = ctxFor(['/roster']);
    resetRosterRefreshAttempts(ctx.config);
    let reconciled = 0;
    const hook = makeUnresolvedSeatHook(ctx, {
      refresh: async () => [{ root: '/roster', outcome: 'failed', detail: 'diverged' }],
      reconcile: async () => {
        reconciled++;
      },
    });
    expect(await hook({ id: 't', slug: 'bravo' }, 'late')).toBe(false);
    expect(reconciled).toBe(0);
  });
});

/**
 * ADR 736: the timed pull. An edit to a seat that already exists never stops a fold, so the ADR 592
 * hook never pulls it — on 2026-10-21 the hub served old roles for hours. Same real-git shape as
 * above: a bare remote, the machine that edits (a) and the machine that must catch up (b).
 */
describe('makeRosterPullTick — pull roster roots on a timer (ADR 736)', () => {
  let root: string;
  let remote: string;
  let a: string;
  let b: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-rosterpull-'));
    remote = join(root, 'remote.git');
    a = join(root, 'a');
    b = join(root, 'b');
    execFileSync('git', ['init', '--quiet', '--bare', '-b', 'main', remote]);
    execFileSync('git', ['clone', '--quiet', remote, a]);
    git(a, 'config', 'user.email', 't@t');
    git(a, 'config', 'user.name', 't');
    mkdirSync(join(a, '.musterd', 'seats'), { recursive: true });
    writeFileSync(join(a, '.musterd', 'seats', 'ghost.toml'), 'kind = "agent"\n');
    git(a, 'add', '.');
    git(a, 'commit', '-q', '-m', 'seat');
    git(a, 'push', '-q', '-u', 'origin', 'main');
    execFileSync('git', ['clone', '--quiet', remote, b]);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('pulls a role edit to an existing seat and reconciles once; a quiet remote reconciles nothing', async () => {
    writeFileSync(
      join(a, '.musterd', 'seats', 'ghost.toml'),
      'kind = "agent"\nroles = ["engineer"]\n',
    );
    git(a, 'commit', '-q', '-am', 'ghost: engineer');
    git(a, 'push', '-q');
    let reconciled = 0;
    const tick = makeRosterPullTick(
      () => [b],
      async () => {
        reconciled += 1;
      },
    );
    await tick();
    expect(git(b, 'log', '-1', '--format=%s')).toBe('ghost: engineer');
    expect(reconciled).toBe(1);
    await tick();
    expect(reconciled).toBe(1);
  });

  it('warns once for a root that keeps failing the same way, and again when it recovers then fails', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    let outcome: RosterRefreshOutcome = {
      root: b,
      outcome: 'failed',
      detail: 'Not possible to fast-forward',
    };
    const tick = makeRosterPullTick(
      () => [b],
      async () => {},
      { refresh: async () => [outcome] },
    );
    await tick();
    await tick();
    expect(warn).toHaveBeenCalledTimes(1);
    outcome = { root: b, outcome: 'current' };
    await tick();
    outcome = { root: b, outcome: 'failed', detail: 'Not possible to fast-forward' };
    await tick();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('does not overlap a tick that is still pulling', async () => {
    let release!: () => void;
    let calls = 0;
    const tick = makeRosterPullTick(
      () => [b],
      async () => {},
      {
        refresh: async () => {
          calls += 1;
          await new Promise<void>((r) => (release = r));
          return [{ root: b, outcome: 'current' }];
        },
      },
    );
    const first = tick();
    await tick();
    release();
    await first;
    expect(calls).toBe(1);
  });
});
