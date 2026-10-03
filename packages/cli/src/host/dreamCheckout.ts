import { execFileSync } from 'node:child_process';

/**
 * Before a dream wake, bring a resting workspace up to `origin/main` (lane 01M41G80VN, ADR 494).
 *
 * A dream's wake line names `.agents/skills/dreaming/SKILL.md`, and the dream runs on whatever the
 * seat's workspace holds. On 2026-10-03 ghost, grokbot and wanderer each dreamed on a detached HEAD
 * days behind #1956, which landed the skill — so the path the wake named did not exist, and each
 * dream spent its first turns discovering that. A seat between lanes rests detached at
 * `origin/main` (AGENTS.md step 6), so moving that rest point forward is the same move the seat
 * would make itself before its next lane.
 *
 * Deliberately narrow, because the workspace is the seat's and a dream is unattended:
 *   · only a DETACHED HEAD — a branch is somebody's lane, never moved;
 *   · only a CLEAN tree — uncommitted work is never touched;
 *   · only a FAST-FORWARD — a detached HEAD carrying commits main lacks is left where it is;
 *   · never a gate — any git failure is one log line and the dream goes ahead as before.
 *
 * Returns the one line to log, or '' when there was nothing to do.
 */
export type GitRunner = (workspace: string, args: string[]) => string;

const realGit: GitRunner = (workspace, args) =>
  execFileSync('git', ['-C', workspace, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
  });

export function freshenForDream(workspace: string, git: GitRunner = realGit): string {
  try {
    try {
      git(workspace, ['symbolic-ref', '-q', 'HEAD']);
      return 'checkout left: on a branch';
    } catch {
      // detached — the only state this moves
    }
    if (git(workspace, ['status', '--porcelain']).trim() !== '')
      return 'checkout left: uncommitted changes';
    git(workspace, ['fetch', '-q', 'origin', 'main']);
    const head = git(workspace, ['rev-parse', 'HEAD']).trim();
    const main = git(workspace, ['rev-parse', 'origin/main']).trim();
    if (head === main) return '';
    try {
      git(workspace, ['merge-base', '--is-ancestor', 'HEAD', 'origin/main']);
    } catch {
      return 'checkout left: HEAD has commits origin/main lacks';
    }
    git(workspace, ['switch', '-q', '--detach', 'origin/main']);
    return `checkout freshened: ${head.slice(0, 8)} → ${main.slice(0, 8)} (origin/main)`;
  } catch (e) {
    return `checkout left: ${(e as Error).message.split('\n')[0]}`;
  }
}
