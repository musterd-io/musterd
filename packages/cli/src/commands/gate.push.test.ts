import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushReportFor } from './gate.js';

/**
 * ADR 730 §1: the Bash PostToolUse hook reports a push only when git's own remote-tracking ref says
 * the branch is at HEAD on that remote. A real repo and a real bare remote, so the check is the one
 * the hook makes, not a stub of it.
 */

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();

function repoWithRemote(): { repo: string; head: string } {
  const root = mkdtempSync(join(tmpdir(), 'musterd-push-'));
  const remote = join(root, 'team.git');
  const repo = join(root, 'work');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'agent1', repo]);
  git(repo, 'config', 'user.email', 's@x');
  git(repo, 'config', 'user.name', 's');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'base');
  git(repo, 'remote', 'add', 'team', remote);
  return { repo, head: git(repo, 'rev-parse', 'HEAD') };
}

const payload = (command: string) =>
  JSON.stringify({ tool_name: 'Bash', tool_input: { command }, tool_response: {} });

describe('pushReportFor (ADR 730)', () => {
  it('reports the remote, branch and head once the push has landed, and nothing before', () => {
    const { repo, head } = repoWithRemote();
    // The command names a push, but the remote-tracking ref is not there yet: nothing to report.
    expect(pushReportFor(payload('git push team agent1'), repo)).toBeNull();
    git(repo, 'push', '-q', 'team', 'agent1');
    expect(pushReportFor(payload('git push team agent1'), repo)).toEqual({
      remote: 'team',
      branch: 'agent1',
      head,
    });
    // A later commit moves HEAD off the pushed ref: the push on record is stale, so nothing.
    writeFileSync(join(repo, 'b.txt'), 'b\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-qm', 'more');
    expect(pushReportFor(payload('git add -A && git push team agent1'), repo)).toBeNull();
  });

  it('ignores commands that do not push, a dry run, and a remote the repo does not have', () => {
    const { repo } = repoWithRemote();
    git(repo, 'push', '-q', 'team', 'agent1');
    expect(pushReportFor(payload('git fetch team'), repo)).toBeNull();
    expect(pushReportFor(payload('git push --dry-run team agent1'), repo)).toBeNull();
    expect(pushReportFor(payload('git push origin agent1'), repo)).toBeNull();
    expect(
      pushReportFor(JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' } }), repo),
    ).toBeNull();
    expect(pushReportFor('not json', repo)).toBeNull();
  });

  it('reports nothing from a detached HEAD', () => {
    const { repo } = repoWithRemote();
    git(repo, 'push', '-q', 'team', 'agent1');
    git(repo, 'checkout', '-q', '--detach');
    expect(pushReportFor(payload('git push team HEAD:agent1'), repo)).toBeNull();
  });
});
