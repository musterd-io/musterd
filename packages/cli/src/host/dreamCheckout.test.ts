import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freshenForDream } from './dreamCheckout.js';

// Real git, in throwaway repos: the guards are about what git reports, so a fake runner would only
// test the fake. `origin` is a bare repo; `ws` is the seat's workspace, resting detached.
describe('freshenForDream (lane 01M41G80VN)', () => {
  let root: string;
  let ws: string;
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
  const commit = (cwd: string, file: string) => {
    writeFileSync(join(cwd, file), file);
    git(cwd, 'add', file);
    git(cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', file);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'musterd-dream-checkout-'));
    const origin = join(root, 'origin.git');
    const up = join(root, 'up');
    ws = join(root, 'ws');
    git(root, 'init', '-q', '--bare', '-b', 'main', origin);
    git(root, 'clone', '-q', origin, up);
    commit(up, 'a');
    git(up, 'push', '-q', 'origin', 'HEAD:main');
    git(root, 'clone', '-q', origin, ws);
    git(ws, 'switch', '-q', '--detach', 'origin/main');
    // main moves on: the skill lands after the seat came to rest.
    commit(up, 'SKILL.md');
    git(up, 'push', '-q', 'origin', 'HEAD:main');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('fast-forwards a clean detached workspace to origin/main, so the skill is there', () => {
    const line = freshenForDream(ws);
    expect(line).toMatch(/^checkout freshened: \w{8} → \w{8} \(origin\/main\)$/);
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(git(ws, 'rev-parse', 'origin/main'));
    expect(git(ws, 'ls-files')).toContain('SKILL.md');
  });

  it('says nothing when the workspace is already current', () => {
    freshenForDream(ws);
    expect(freshenForDream(ws)).toBe('');
  });

  it('never moves a branch — that is somebody’s lane', () => {
    git(ws, 'switch', '-q', '-c', 'feat/x');
    const before = git(ws, 'rev-parse', 'HEAD');
    expect(freshenForDream(ws)).toBe('checkout left: on a branch');
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('never touches uncommitted work', () => {
    writeFileSync(join(ws, 'a'), 'edited');
    const before = git(ws, 'rev-parse', 'HEAD');
    expect(freshenForDream(ws)).toBe('checkout left: uncommitted changes');
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('leaves a detached HEAD carrying commits main lacks', () => {
    commit(ws, 'local');
    const before = git(ws, 'rev-parse', 'HEAD');
    expect(freshenForDream(ws)).toBe('checkout left: HEAD has commits origin/main lacks');
    expect(git(ws, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('never throws: a folder that is not a repo is one line', () => {
    expect(freshenForDream(join(root, 'nope'))).toMatch(/^checkout left: /);
  });
});
