import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import {
  makeUnresolvedSeatHook,
  refreshRosterRoot,
  resetRosterRefreshAttempts,
  ROSTER_REFRESH_MIN_INTERVAL_MS,
  type RosterRefreshOutcome,
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
