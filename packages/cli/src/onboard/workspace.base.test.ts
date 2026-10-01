import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { provisionWorkspace, resolveBaseRef } from './workspace.js';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
let root: string;
let checkout: string;
let mainTip: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-base-')));
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  const seed = join(root, 'seed');
  git(root, 'clone', '-q', origin, seed);
  writeFileSync(join(seed, 'a'), '1');
  git(seed, 'add', 'a');
  git(seed, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'main');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
  mainTip = git(seed, 'rev-parse', 'HEAD');
  // The acting checkout: a clone of origin with a feature branch checked out, one commit ahead.
  checkout = join(root, 'musterd', 'acme', 'proj', 'nick');
  git(root, 'clone', '-q', origin, checkout);
  git(checkout, 'switch', '-qc', 'feature');
  writeFileSync(join(checkout, 'b'), '2');
  git(checkout, 'add', 'b');
  git(checkout, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'feature');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('base ref (ADR 491)', () => {
  it('resolves the remote default branch tip', () => {
    expect(resolveBaseRef(checkout)).toBe(mainTip);
  });

  it('a new Workspace starts at the base, not at whatever branch the checkout has open', () => {
    const ws = provisionWorkspace('ada', {
      cwd: checkout,
      team: 'acme',
      home: root,
      base: mainTip,
    });
    expect(ws.dir).toBe(join(root, 'musterd', 'acme', 'proj', 'ada'));
    expect(git(ws.dir, 'rev-parse', 'HEAD')).toBe(mainTip);
    // --no-track: the seat's branch is its own, with no upstream.
    expect(() => git(ws.dir, 'config', 'branch.agent/ada.remote')).toThrow();
  });

  it("without a base it keeps today's behavior (the checkout HEAD)", () => {
    const ws = provisionWorkspace('bo', { cwd: checkout, team: 'acme', home: root });
    expect(git(ws.dir, 'rev-parse', 'HEAD')).toBe(git(checkout, 'rev-parse', 'HEAD'));
  });

  it('answers null when there is no remote', () => {
    const lonely = join(root, 'lonely');
    git(root, 'init', '-q', lonely);
    expect(resolveBaseRef(lonely)).toBeNull();
  });
});
