import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  computeSiteGap,
  nextAction,
  siteGapAskBody,
  siteGapLine,
  sitePathspecs,
  SITE_PATHS,
  type GitReader,
  type SiteGap,
} from './siteGap.js';

const TIP = 'ac064bb3ad79068118159709677c12e00fc8763d';
const DEPLOYED = 'c432fbb3ad79068118159709677c12e00fc8763d';

function git(commits: string[], known = [DEPLOYED, TIP]): GitReader & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hasCommit: (ref) => known.includes(ref),
    logRange: (from, to, paths) => {
      calls.push(`${from}..${to} -- ${paths.join(' ')}`);
      return commits;
    },
  };
}

describe('computeSiteGap', () => {
  it('reads current when nothing site-affecting landed since the deployed ref', () => {
    const g = git([]);
    expect(computeSiteGap({ ref: DEPLOYED }, TIP, g)).toEqual({
      status: 'current',
      deployed: DEPLOYED,
      tip: TIP,
      behind: [],
    });
    expect(g.calls).toEqual([`${DEPLOYED}..${TIP} -- ${SITE_PATHS.join(' ')}`]);
  });

  it('lists the site-affecting commits, newest first, when the site is behind', () => {
    const g = git([
      '3076e7a0\tscope the what-is card at both ends',
      '7ae57d44\tdrop the LIVE pill',
    ]);
    const gap = computeSiteGap({ ref: DEPLOYED }, TIP, g);
    expect(gap.status).toBe('behind');
    expect(gap.behind).toEqual([
      { sha: '3076e7a0', subject: 'scope the what-is card at both ends' },
      { sha: '7ae57d44', subject: 'drop the LIVE pill' },
    ]);
  });

  it('cannot measure a site with no marker, and says so instead of guessing', () => {
    expect(computeSiteGap(null, TIP, git([])).status).toBe('no_marker');
    expect(computeSiteGap({ ref: null }, TIP, git([])).status).toBe('no_marker');
  });

  it('strips -dirty before asking git, and keeps it in the report', () => {
    const g = git([], [DEPLOYED, TIP]);
    const gap = computeSiteGap({ ref: `${DEPLOYED}-dirty` }, TIP, g);
    expect(gap.status).toBe('current');
    expect(gap.deployed).toBe(`${DEPLOYED}-dirty`);
    expect(g.calls[0]).toMatch(new RegExp(`^${DEPLOYED}\\.\\.`));
  });

  it('reports a ref the checkout lacks as unknown rather than as current or behind', () => {
    const gap = computeSiteGap({ ref: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }, TIP, git([]));
    expect(gap.status).toBe('unknown_ref');
    expect(siteGapLine(gap, 'https://musterd.io')).toMatch(/does not have/);
  });
});

/**
 * The exclusion is git's pathspec semantics, so a fake reader cannot prove it — this one runs real
 * `git log` in a throwaway repo with the same pathspecs the service passes (lane 01M4VA7NQG).
 * The list mirrors the shape `stage-allowlist.mjs` `DAEMON_ONLY_SOURCES` gives; the CLI reads the
 * real one at run time.
 */
describe('daemon-only web sources are not site-affecting', () => {
  const DAEMON_ONLY = ['src/live', 'src/routes/live.*', 'src/routes/board.*'];
  const repo = mkdtempSync(join(tmpdir(), 'musterd-site-gap-'));
  afterAll(() => rmSync(repo, { recursive: true, force: true }));
  const run = (...args: string[]) => {
    const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const commit = (subject: string, files: string[]) => {
    for (const f of files) {
      mkdirSync(join(repo, dirname(f)), { recursive: true });
      writeFileSync(join(repo, f), `${subject}\n`);
    }
    run('add', '-A');
    run('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', subject);
    return run('rev-parse', 'HEAD');
  };
  const reader: GitReader = {
    hasCommit: (ref) =>
      spawnSync('git', ['cat-file', '-e', `${ref}^{commit}`], { cwd: repo }).status === 0,
    logRange: (from, to, paths) =>
      run('log', '--format=%h%x09%s', `${from}..${to}`, '--', ...paths)
        .split('\n')
        .filter((l) => l.length > 0),
  };

  run('init', '-q');
  const base = commit('base', ['packages/web/src/components/site/Hero.tsx', 'README.md']);
  commit('live only', ['packages/web/src/live/NowCard.tsx']);
  commit('board route only', ['packages/web/src/routes/board.tsx']);
  commit('live and site', [
    'packages/web/src/live/NowCard.tsx',
    'packages/web/src/components/site/Hero.tsx',
  ]);
  commit('public route', ['packages/web/src/routes/watch.tsx']);
  commit('outside web', ['README.md']);
  const tip = run('rev-parse', 'HEAD');

  it('maps each daemon-only source to an exclude under packages/web', () => {
    expect(sitePathspecs(['src/live', 'src/routes/live.*'])).toEqual([
      'packages/web',
      ':(exclude)packages/web/src/live',
      ':(exclude)packages/web/src/routes/live.*',
    ]);
    expect(sitePathspecs([])).toEqual([...SITE_PATHS]);
  });

  it('does not count a commit that touches only src/live or a daemon route', () => {
    const gap = computeSiteGap({ ref: base }, tip, reader, DAEMON_ONLY);
    expect(gap.behind.map((c) => c.subject)).toEqual(['public route', 'live and site']);
  });

  it('counts everything under packages/web when the list is empty — the conservative fallback', () => {
    const gap = computeSiteGap({ ref: base }, tip, reader, []);
    expect(gap.behind.map((c) => c.subject)).toEqual([
      'public route',
      'live and site',
      'board route only',
      'live only',
    ]);
  });

  it('reads current when only daemon-only commits landed since the deploy', () => {
    const live = commit('live again', ['packages/web/src/live/Other.tsx']);
    expect(computeSiteGap({ ref: tip }, live, reader, DAEMON_ONLY).status).toBe('current');
  });
});

describe('the ask body', () => {
  const behind: SiteGap = {
    status: 'behind',
    deployed: DEPLOYED,
    tip: TIP,
    behind: [{ sha: '7ae57d44', subject: 'drop the LIVE pill' }],
  };
  it('names the gap, the commits, the command and ADR 308, and that it self-resolves', () => {
    const body = siteGapAskBody(behind, 'https://musterd.io');
    expect(body).toContain('c432fbb3 — 1 site-affecting commit(s) behind ac064bb3');
    expect(body).toContain('7ae57d44 drop the LIVE pill');
    expect(body).toContain('deploy:site');
    expect(body).toContain('ADR 308');
    expect(body).toContain('resolves itself');
  });
  it('caps the list so a month of drift is one ask, not a scroll', () => {
    const many = {
      ...behind,
      behind: Array.from({ length: 20 }, (_, i) => ({ sha: `sha${i}`, subject: 's' })),
    };
    expect(siteGapAskBody(many, 'x')).toContain('… and 8 more');
  });
});

describe('nextAction — one open ask per deployed ref', () => {
  const behind: SiteGap = {
    status: 'behind',
    deployed: DEPLOYED,
    tip: TIP,
    behind: [{ sha: 'a', subject: 'b' }],
  };
  const current: SiteGap = { status: 'current', deployed: TIP, tip: TIP, behind: [] };
  const stamp = (deployed: string | null, ask: string | null) => ({
    deployed,
    tip: TIP,
    ask,
    raised_at: 1,
  });

  it('raises once when the site first reads behind', () => {
    expect(nextAction(null, behind)).toBe('raise');
    expect(nextAction(stamp(DEPLOYED, null), behind)).toBe('raise');
  });
  it('does not raise again when main moves but the deployed ref has not', () => {
    expect(nextAction(stamp(DEPLOYED, '01ASK'), { ...behind, tip: 'newer' })).toBe('none');
  });
  it('resolves the open ask when the deployed ref changes — a partial catch-up re-raises on the next tick', () => {
    expect(nextAction(stamp('older', '01ASK'), behind)).toBe('resolve');
  });
  it('resolves when the site catches up, and stays silent when it was never behind', () => {
    expect(nextAction(stamp(DEPLOYED, '01ASK'), current)).toBe('resolve');
    expect(nextAction(null, current)).toBe('none');
    expect(nextAction(stamp(TIP, null), current)).toBe('none');
  });
  it('never raises on a gap it cannot name', () => {
    expect(nextAction(null, { status: 'no_marker', deployed: null, tip: TIP, behind: [] })).toBe(
      'none',
    );
    expect(nextAction(null, { status: 'unknown_ref', deployed: 'x', tip: TIP, behind: [] })).toBe(
      'none',
    );
  });
});
