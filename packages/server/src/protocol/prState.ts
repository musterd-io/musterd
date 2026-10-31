import { execFile } from 'node:child_process';
import type { QuickActionPr } from '@musterd/protocol';

/**
 * A lane's PR as the hub's own `gh` sees it (ADR 779 §4) — no new GitHub credential: the hub's
 * login, the daemon's checkout as the repo. Where `gh` is missing or not logged in, the answer says
 * so (`no_gh`), and the caller tells the seat and the card instead of failing silently.
 */

/**
 * Which GitHub repository each team's lanes live in (security review, 2026-10-30): the hub reads
 * PRs only for a team an operator mapped, and always with `--repo`, so one team's lanes are never
 * matched against another's repository. `MUSTERD_PR_WATCH_REPOS="revive=musterd-io/musterd,…"`.
 * Unset, nothing is watched and Check PR says so.
 */
export function prWatchRepos(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const out = new Map<string, string>();
  for (const pair of (env['MUSTERD_PR_WATCH_REPOS'] ?? '').split(',')) {
    const [team, repo] = pair.trim().split('=');
    if (
      team &&
      repo &&
      /^[a-z0-9-]{1,32}$/.test(team) &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)
    )
      out.set(team, repo);
  }
  return out;
}

/** Runs `gh` with arguments; injected so tests never shell out. Resolves stdout, rejects with the error. */
export type GhRunner = (args: string[]) => Promise<string>;

const GH_TIMEOUT_MS = 5_000;

export const runGh: GhRunner = (args) =>
  new Promise((resolve, reject) => {
    execFile('gh', args, { timeout: GH_TIMEOUT_MS, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(Object.assign(err, { stderr: String(stderr ?? '') }));
      else resolve(String(stdout));
    });
  });

interface GhPr {
  number: number;
  state: string;
  /** A PR from a fork. Never the lane's own: a stranger can name a fork branch anything. */
  isCrossRepository?: boolean;
  statusCheckRollup?: Array<{
    conclusion?: string | null;
    status?: string | null;
    state?: string | null;
  }>;
}

/** Collapse the rollup: any failure is red; anything still running is pending; else green; none is none. */
export function rollupChecks(
  rollup: GhPr['statusCheckRollup'],
): 'green' | 'red' | 'pending' | 'none' {
  if (!rollup || rollup.length === 0) return 'none';
  const outcomes = rollup.map((c) => (c.conclusion ?? c.state ?? c.status ?? '').toUpperCase());
  if (
    outcomes.some((o) =>
      ['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED'].includes(o),
    )
  )
    return 'red';
  if (
    outcomes.some((o) =>
      ['', 'PENDING', 'IN_PROGRESS', 'QUEUED', 'EXPECTED', 'WAITING'].includes(o),
    )
  )
    return 'pending';
  return 'green';
}

/**
 * A branch name `gh` can only read as a branch: git's own allowed characters, never a leading `-`
 * (a seat sets its lane's branch, so `--repo=…` must not reach `gh` as a flag — security review,
 * 2026-10-30). The `--` before it is the second fence.
 */
export function isSafeRef(ref: string | number): boolean {
  if (typeof ref === 'number') return Number.isInteger(ref) && ref > 0;
  return /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,199}$/.test(ref) && !ref.includes('..');
}

/** The PR for a branch (or a PR number). */
export async function readPrState(
  ref: string | number,
  repo: string | undefined,
  run: GhRunner = runGh,
): Promise<QuickActionPr> {
  if (!repo) return { unknown: 'no_repo' };
  if (!isSafeRef(ref)) return { unknown: 'gh_error' };
  let out: string;
  try {
    out = await run([
      'pr',
      'view',
      '--repo',
      repo,
      '--json',
      'number,state,statusCheckRollup,isCrossRepository',
      '--',
      String(ref),
    ]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') return { unknown: 'no_gh' };
    const said = `${e.stderr ?? ''} ${e.message ?? ''}`.toLowerCase();
    if (
      said.includes('no pull requests found') ||
      said.includes('could not resolve to a pullrequest')
    )
      return { unknown: 'no_pr' };
    if (said.includes('gh auth login') || said.includes('not logged')) return { unknown: 'no_gh' };
    return { unknown: 'gh_error' };
  }
  try {
    const pr = JSON.parse(out) as GhPr;
    if (pr.isCrossRepository) return { unknown: 'no_pr' };
    const state =
      pr.state.toUpperCase() === 'MERGED'
        ? 'merged'
        : pr.state.toUpperCase() === 'CLOSED'
          ? 'closed'
          : 'open';
    return { number: pr.number, state, checks: rollupChecks(pr.statusCheckRollup) };
  } catch {
    return { unknown: 'gh_error' };
  }
}

/** One `gh pr list` row the watch needs. */
export interface ListedPr {
  number: number;
  branch: string;
  state: 'open' | 'merged' | 'closed';
  checks: 'green' | 'red' | 'pending' | 'none';
  url: string | undefined;
}

/**
 * Every recent PR, newest first, by head branch — ONE `gh` call per sweep rather than one per lane
 * (ADR 779 §4), so a team of twenty lanes costs one API request a minute.
 */
export async function listPrsByBranch(
  repo: string,
  run: GhRunner = runGh,
): Promise<Map<string, ListedPr> | { unknown: 'no_gh' | 'gh_error' }> {
  let out: string;
  try {
    out = await run([
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '200',
      '--json',
      'number,headRefName,state,statusCheckRollup,url,isCrossRepository',
    ]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') return { unknown: 'no_gh' };
    const said = `${e.stderr ?? ''} ${e.message ?? ''}`.toLowerCase();
    if (said.includes('gh auth login') || said.includes('not logged')) return { unknown: 'no_gh' };
    return { unknown: 'gh_error' };
  }
  try {
    const rows = JSON.parse(out) as Array<GhPr & { headRefName: string; url?: string }>;
    const byBranch = new Map<string, ListedPr>();
    for (const r of rows) {
      if (r.isCrossRepository) continue; // a fork's branch name proves nothing about our lanes
      if (byBranch.has(r.headRefName)) continue; // newest first: keep the first seen per branch
      const s = r.state.toUpperCase();
      byBranch.set(r.headRefName, {
        number: r.number,
        branch: r.headRefName,
        state: s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open',
        checks: rollupChecks(r.statusCheckRollup),
        url: r.url,
      });
    }
    return byBranch;
  } catch {
    return { unknown: 'gh_error' };
  }
}
