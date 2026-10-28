import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WikiSourceSchema } from '@musterd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createWikiReader, wikiTitle, type GitRunner, WIKI_CHECK_INTERVAL_MS } from './wiki.js';

/**
 * ADR 747, against real git. The "remote" is a local repo; the runner rewrites the https URL to it
 * (`url.insteadOf`) and allows the file transport for the test only — the boxed runner the daemon
 * uses refuses both, which `boxedGit refuses file://` below holds it to.
 */

const REPO = 'https://example.test/acme/app';
let tmp: string;
let remote: string;
let clock: number;

function sh(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function commit(files: Record<string, string>, msg: string): void {
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(remote, path, '..'), { recursive: true });
    writeFileSync(join(remote, path), body);
  }
  sh(remote, 'add', '-A');
  sh(remote, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', msg);
}

const testGit: GitRunner = async (args, cwd) =>
  execFileSync(
    'git',
    [
      ...(cwd ? ['-C', cwd] : []),
      '-c',
      `url.file://${remote}.insteadOf=${REPO}`,
      '-c',
      'protocol.file.allow=always',
      ...args,
    ],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
    },
  );

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'wiki-test-'));
  remote = join(tmp, 'remote');
  mkdirSync(remote);
  sh(remote, 'init', '-q', '-b', 'main');
  sh(remote, 'config', 'uploadpack.allowFilter', 'true');
  commit(
    {
      'docs/wiki/amending-an-adr.md': '# Amending an ADR\n\nBody.\n',
      'docs/wiki/ops/rotation.md': 'no heading here\n',
      'docs/wiki/notes.txt': 'not markdown',
      'src/secret.md': '# Outside the wiki',
    },
    'one',
  );
  clock = 1_000_000;
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const source = WikiSourceSchema.parse({ repo: REPO });
const reader = () => createWikiReader({ root: join(tmp, 'cache'), git: testGit, now: () => clock });

describe('wiki reader (ADR 747)', () => {
  it('lists only the markdown in the wiki folder, titled by first heading', async () => {
    const idx = await reader().index('t1', source);
    expect(idx.state).toBe('ready');
    if (idx.state !== 'ready') return;
    expect(idx.branch).toBe('main');
    expect(idx.stale).toBe(false);
    expect(idx.pages.map((p) => [p.path, p.title])).toEqual([
      ['amending-an-adr.md', 'Amending an ADR'],
      ['ops/rotation.md', 'rotation'],
    ]);
  });

  it('serves a page, and nothing outside the folder or the index', async () => {
    const r = reader();
    expect((await r.page('t1', source, 'amending-an-adr.md'))?.markdown).toContain('Body.');
    expect(await r.page('t1', source, '../../src/secret.md')).toBeNull();
    expect(await r.page('t1', source, 'notes.txt')).toBeNull();
    expect(await r.page('t1', source, 'missing.md')).toBeNull();
  });

  it('checks the remote again only after the interval, and picks up what merged', async () => {
    const r = reader();
    await r.index('t1', source);
    commit({ 'docs/wiki/new-page.md': '# New page\n' }, 'two');
    // Inside the window: the cache answers, no network.
    expect((await r.index('t1', source)).state === 'ready').toBe(true);
    let idx = await r.index('t1', source);
    if (idx.state === 'ready') expect(idx.pages).toHaveLength(2);
    // Past it: this read is served from the cache while the check runs behind it…
    clock += WIKI_CHECK_INTERVAL_MS;
    await r.index('t1', source);
    // …and the next read sees the new page.
    await new Promise((res) => setTimeout(res, 50));
    for (let i = 0; i < 40; i++) {
      idx = await r.index('t1', source);
      if (idx.state === 'ready' && idx.pages.length === 3) break;
      await new Promise((res) => setTimeout(res, 50));
    }
    expect(idx.state === 'ready' && idx.pages.map((p) => p.title)).toContain('New page');
  });

  it('checks a symlink out as a plain file, so it cannot point at the disk', async () => {
    symlinkSync('/etc/hosts', join(remote, 'docs/wiki/leak.md'));
    commit({}, 'link');
    const r = reader();
    const page = await r.page('t1', source, 'leak.md');
    expect(page?.markdown ?? '').not.toMatch(/localhost/);
  });

  it('says what git said when the repo cannot be read, with no cache to fall back on', async () => {
    const bad = WikiSourceSchema.parse({ repo: 'https://example.test/nobody/nothing' });
    const idx = await reader().index('t1', bad);
    expect(idx.state).toBe('failed');
  });

  it('marks a read stale when the check fails after a good read', async () => {
    let offline = false;
    const flaky: GitRunner = async (args, cwd) => {
      if (offline) throw Object.assign(new Error('x'), { stderr: 'fatal: unable to access' });
      return testGit(args, cwd);
    };
    const r = createWikiReader({ root: join(tmp, 'cache'), git: flaky, now: () => clock });
    await r.index('t1', source);
    offline = true;
    clock += WIKI_CHECK_INTERVAL_MS;
    await r.index('t1', source);
    await new Promise((res) => setTimeout(res, 20));
    const idx = await r.index('t1', source);
    expect(idx.state === 'ready' && idx.stale).toBe(true);
  });
});

describe('wikiTitle', () => {
  it('reads a heading as plain text', () => {
    expect(wikiTitle('a.md', '# `team create` binds **the** [folder](x.md)\n')).toBe(
      'team create binds the folder',
    );
  });
  it('skips headings inside code fences', () => {
    expect(wikiTitle('a.md', '```\n# not this\n```\n# This one\n')).toBe('This one');
  });
});

describe('boxedGit', () => {
  it('refuses file://', async () => {
    const { boxedGit } = await import('./wiki.js');
    await expect(boxedGit(['ls-remote', '--', `file://${tmp}`, 'HEAD'])).rejects.toThrow();
  });
});
