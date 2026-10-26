import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { pushContextLine, pushReportFor } from './gate.js';

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

  it('reports nothing when the command pushed another branch, even from an up-to-date lane branch', () => {
    // Big-body's decline (lane 01M5RQQ4T2, 2026-10-25): agent1 is already at HEAD on the remote, so
    // the tracking ref alone would say "pushed" for any push command run from this branch.
    const { repo, head } = repoWithRemote();
    git(repo, 'push', '-q', 'team', 'agent1');
    git(repo, 'branch', 'other');
    git(repo, 'push', '-q', 'team', 'other');
    expect(pushReportFor(payload('git push team other'), repo)).toBeNull();
    expect(pushReportFor(payload('git push team other:agent1-review'), repo)).toBeNull();
    expect(pushReportFor(payload('git push team HEAD:other'), repo)).toBeNull();
    expect(pushReportFor(payload('git push -d team other'), repo)).toBeNull();
    // The current branch, by any of its spellings, still reports.
    const report = { remote: 'team', branch: 'agent1', head };
    expect(pushReportFor(payload('git push team'), repo)).toEqual(report);
    expect(pushReportFor(payload('git push -u team HEAD'), repo)).toEqual(report);
    expect(pushReportFor(payload('git push team HEAD:agent1'), repo)).toEqual(report);
    expect(pushReportFor(payload('git push team +agent1:refs/heads/agent1'), repo)).toEqual(report);
    expect(pushReportFor(payload('git push --all team'), repo)).toEqual(report);
  });

  it('trusts a harness exit code or interrupted flag when the payload carries one', () => {
    const { repo, head } = repoWithRemote();
    git(repo, 'push', '-q', 'team', 'agent1');
    const withResponse = (tool_response: unknown) =>
      JSON.stringify({
        tool_name: 'Bash',
        tool_input: { command: 'git push team agent1' },
        tool_response,
      });
    expect(pushReportFor(withResponse({ exit_code: 1 }), repo)).toBeNull();
    expect(pushReportFor(withResponse({ interrupted: true }), repo)).toBeNull();
    expect(pushReportFor(withResponse({ exit_code: 0, stdout: '' }), repo)).toEqual({
      remote: 'team',
      branch: 'agent1',
      head,
    });
    expect(pushReportFor(withResponse({ stdout: 'Everything up-to-date' }), repo)).not.toBeNull();
  });

  it('reports nothing from a detached HEAD', () => {
    const { repo } = repoWithRemote();
    git(repo, 'push', '-q', 'team', 'agent1');
    git(repo, 'checkout', '-q', '--detach');
    expect(pushReportFor(payload('git push team HEAD:agent1'), repo)).toBeNull();
  });
});

describe('pushContextLine (ADR 731)', () => {
  const report = { remote: 'team', branch: 'agent1', head: 'abc123def4567890abcdef' };
  it('names the seats told, so the pusher does not say it again', () => {
    expect(pushContextLine(report, { lanes: 1, acts: 1, told: ['agent2'] })).toBe(
      'musterd: your push of agent1 at abc123def456 on team is recorded on your lane; agent2 was told to fetch it before editing the files your lane names — no need to say so by hand.',
    );
    expect(pushContextLine(report, { lanes: 1, acts: 2, told: ['agent2', 'agent3'] })).toContain(
      'agent2, agent3 were told',
    );
  });
  it('says nobody was told when the lane has no audience, and nothing at all for no lane or no answer', () => {
    expect(pushContextLine(report, { lanes: 1, acts: 0, told: [] })).toContain(
      'no other lane covers the files it names and nobody is waiting on it, so no one was told',
    );
    expect(pushContextLine(report, { lanes: 0, acts: 0, told: [] })).toBeNull();
    expect(pushContextLine(report, null)).toBeNull();
  });
});
