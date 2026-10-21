import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_PROJECT,
  repoProject,
  resolveProject,
  resolveWorkspace,
  resolveWorkspaceKey,
} from './project.js';

// A pass-through spy, so a test can count the git processes a resolver spawns (lane 01M4S9SCT5).
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, execFileSync: vi.fn(actual.execFileSync) };
});

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

describe('resolveProject', () => {
  let root: string;
  let repo: string;
  let worktreeA: string;
  let worktreeB: string;
  let plain: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-project-'));
    repo = join(root, 'acme');
    mkdirSync(repo);
    git(['init', '-q', '-b', 'main'], repo);
    git(['config', 'user.email', 'test@musterd.test'], repo);
    git(['config', 'user.name', 'test'], repo);
    writeFileSync(join(repo, 'README.md'), '# acme\n');
    git(['add', '.'], repo);
    git(['commit', '-qm', 'init'], repo);
    // Exactly the shape `provisionWorkspace` creates: sibling worktrees named <repo>-<seat>.
    worktreeA = join(root, 'acme-ada');
    worktreeB = join(root, 'acme-bo');
    git(['worktree', 'add', '-q', '-b', 'agent/ada', worktreeA, 'HEAD'], repo);
    git(['worktree', 'add', '-q', '-b', 'agent/bo', worktreeB, 'HEAD'], repo);
    plain = join(root, 'not-a-repo');
    mkdirSync(plain);
  });

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('derives the repo name at the top of the main work tree', () => {
    expect(repoProject(repo)).toBe('acme');
  });

  it('derives the same name from a subdirectory', () => {
    const sub = join(repo, 'packages', 'server');
    mkdirSync(sub, { recursive: true });
    expect(repoProject(sub)).toBe('acme');
  });

  /**
   * The load-bearing case, and the reason this does not use `--show-toplevel`: musterd gives every
   * seat its own worktree, so a per-worktree name would fragment one repo into N projects and turn
   * surface-overlap off for the whole team — silently, because the checks are warn-only.
   */
  it('agrees across sibling worktrees of one repo', () => {
    expect(repoProject(worktreeA)).toBe('acme');
    expect(repoProject(worktreeB)).toBe('acme');
    expect(repoProject(worktreeA)).toBe(repoProject(repo));
  });

  it('falls back to the default outside a work tree', () => {
    expect(repoProject(plain)).toBeNull();
    expect(resolveProject({ cwd: plain, env: {} })).toBe(DEFAULT_PROJECT);
  });

  it('derives the same project from an origin remote even when folder names differ (ADR 695)', () => {
    // A second clone of `acme` under a different folder name, sharing the same origin.
    const clone = join(root, 'acme-fork');
    mkdirSync(clone);
    git(['init', '-q', '-b', 'main'], clone);
    git(['config', 'user.email', 'test@musterd.test'], clone);
    git(['config', 'user.name', 'test'], clone);
    // Point both at the same origin URL (no network needed — remote is just config).
    git(['remote', 'add', 'origin', 'https://example.com/acme-org/acme.git'], repo);
    git(['remote', 'add', 'origin', 'https://example.com/acme-org/acme.git'], clone);
    // Worktrees of the origin-less repo still fall back to folder name; here origin wins.
    expect(repoProject(repo)).toBe('acme');
    expect(repoProject(clone)).toBe('acme');
    expect(repoProject(repo)).toBe(repoProject(clone));
  });

  it('falls back to the folder name when there is no origin remote', () => {
    // `repo` had an origin added above; remove it to restore the no-origin case.
    // (Use a fresh repo to be independent.)
    const noOrigin = join(root, 'no-origin-repo');
    mkdirSync(noOrigin);
    git(['init', '-q', '-b', 'main'], noOrigin);
    expect(repoProject(noOrigin)).toBe('no-origin-repo');
  });

  it('prefers an explicit project over everything', () => {
    expect(resolveProject({ explicit: 'chosen', env: { MUSTERD_PROJECT: 'env' }, cwd: repo })).toBe(
      'chosen',
    );
  });

  it('prefers MUSTERD_PROJECT over the derived repo identity', () => {
    expect(resolveProject({ env: { MUSTERD_PROJECT: 'env' }, cwd: repo })).toBe('env');
  });

  it('treats a blank explicit/env value as undeclared', () => {
    expect(resolveProject({ explicit: '   ', env: { MUSTERD_PROJECT: '  ' }, cwd: repo })).toBe(
      'acme',
    );
  });

  it('sanitizes whitespace and caps length', () => {
    expect(resolveProject({ explicit: ' two words ', env: {} })).toBe('two-words');
    expect(resolveProject({ explicit: 'x'.repeat(200), env: {} })).toHaveLength(80);
  });
});

describe('resolveWorkspaceKey (branch-invariant workspace identity, lane 01M1JQYYAC)', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'musterd-wskey-'));
    git(['init'], repo);
    git(
      ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-m', 'seed'],
      repo,
    );
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('is the same before and after a branch switch — the bug this exists to fix', () => {
    const onDefault = resolveWorkspaceKey({}, repo);
    git(['checkout', '-b', 'feature'], repo);
    expect(resolveWorkspaceKey({}, repo)).toBe(onDefault);
  });

  it('is the same on a detached HEAD, where the display label loses its qualifier', () => {
    const named = resolveWorkspaceKey({}, repo);
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo }).toString().trim();
    git(['checkout', '--detach', head], repo);
    expect(resolveWorkspaceKey({}, repo)).toBe(named);
  });

  it('is the same from a subdirectory of the work tree', () => {
    const sub = join(repo, 'packages', 'deep');
    mkdirSync(sub, { recursive: true });
    expect(resolveWorkspaceKey({}, sub)).toBe(resolveWorkspaceKey({}, repo));
  });

  it('distinguishes two different work trees, which is the collision the label could not see', () => {
    const other = mkdtempSync(join(tmpdir(), 'musterd-wskey-'));
    try {
      git(['init'], other);
      expect(resolveWorkspaceKey({}, other)).not.toBe(resolveWorkspaceKey({}, repo));
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it('honours a declared MUSTERD_WORKSPACE — an override names the workspace on both axes', () => {
    expect(resolveWorkspaceKey({ MUSTERD_WORKSPACE: '  auth rewrite ' }, repo)).toBe(
      'auth rewrite',
    );
  });

  it('degrades to the cwd outside a work tree, and never throws', () => {
    expect(resolveWorkspaceKey({}, '/')).toBe('/');
  });
});

describe('resolveWorkspace (where-on-attach label, ADR 014 — moved here from @musterd/mcp, ADR 379 amendment)', () => {
  it('uses the declared override verbatim, capped at 120 chars', () => {
    expect(resolveWorkspace({ MUSTERD_WORKSPACE: 'auth rewrite' }, '/tmp/whatever')).toBe(
      'auth rewrite',
    );
    const long = 'x'.repeat(200);
    expect(resolveWorkspace({ MUSTERD_WORKSPACE: long }, '/tmp/whatever').length).toBe(120);
  });

  it('falls back to the cwd folder name when not a git repo and nothing declared', () => {
    const label = resolveWorkspace({}, '/');
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
  });

  it('qualifies the folder with the git branch (folder@branch) on a named branch', () => {
    const dir = mkdtempSync(join(tmpdir(), 'musterd-ws-'));
    try {
      const g = (...args: string[]) =>
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
          cwd: dir,
          stdio: 'ignore',
        });
      g('init');
      g('checkout', '-b', 'my-branch');
      g('commit', '--allow-empty', '-m', 'seed');
      expect(resolveWorkspace({}, dir)).toBe(`${basename(dir)}@my-branch`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /** A throwaway repo; `seed` makes a first commit so HEAD is born. */
  function repoIn(seed: boolean): { dir: string; g: (...args: string[]) => void } {
    // The real path: macOS tmpdir() sits behind /var -> /private/var, and git reports the toplevel
    // resolved, so a symlinked cwd would read as outside the tree and lose its subpath.
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-ws-')));
    const g = (...args: string[]) =>
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], {
        cwd: dir,
        stdio: 'ignore',
      });
    g('init');
    g('checkout', '-b', 'my-branch');
    if (seed) g('commit', '--allow-empty', '-m', 'seed');
    return { dir, g };
  }

  it('asks git once for the folder@branch label (the MCP startup path)', () => {
    const { dir } = repoIn(true);
    try {
      const spy = vi.mocked(execFileSync);
      const before = spy.mock.calls.length;
      expect(resolveWorkspace({}, dir)).toBe(`${basename(dir)}@my-branch`);
      expect(spy.mock.calls.length - before).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a detached HEAD names no branch, so the subpath qualifies instead', () => {
    const { dir, g } = repoIn(true);
    try {
      g('checkout', '--detach');
      mkdirSync(join(dir, 'pkg'));
      expect(resolveWorkspace({}, join(dir, 'pkg'))).toBe('pkg@pkg');
      expect(resolveWorkspace({}, dir)).toBe(basename(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an unborn HEAD (no commit yet) still finds the toplevel, so the subpath qualifies', () => {
    const { dir } = repoIn(false);
    try {
      mkdirSync(join(dir, 'pkg'));
      expect(resolveWorkspace({}, join(dir, 'pkg'))).toBe('pkg@pkg');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the label and the key agree on the declared override — one workspace on both axes (ADR 368)', () => {
    const env = { MUSTERD_WORKSPACE: 'one-workspace' };
    expect(resolveWorkspace(env, '/a')).toBe(resolveWorkspaceKey(env, '/b'));
  });
});
