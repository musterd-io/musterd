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

/** A `gh` runner that gives up after `timeoutMs`. */
export function ghRunner(timeoutMs: number): GhRunner {
  return (args) =>
    new Promise((resolve, reject) => {
      execFile('gh', args, { timeout: timeoutMs, maxBuffer: 4 << 20 }, (err, stdout, stderr) => {
        if (err) reject(Object.assign(err, { stderr: String(stderr ?? '') }));
        else resolve(String(stdout));
      });
    });
}

/** One PR, read where a seat or a person is waiting. */
export const runGh: GhRunner = ghRunner(5_000);

/**
 * The watch's list read, off any request path. A list of recent PRs with their checks takes the
 * hub's `gh` several seconds (7.5 s for 200 on 2026-10-31), so the 5 s read timed out every sweep
 * and the watch never told anyone anything.
 */
export const runGhList: GhRunner = ghRunner(30_000);

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
  /** The lane ids the PR names: `Lane \`<id>\`.` in its body's first five lines, or `(lane <id>)` in its title (ADR 106). */
  lanes: string[];
}

/** How many recent PRs one sweep reads, newest first. */
export const PR_LIST_LIMIT = 100;

const LANE_REF = /\blane\s+`?([0-9a-hjkmnp-tv-z]{10,26})`?/gi;

/** The lane ids a PR's title and the first five lines of its body name, upper-cased. */
export function laneRefs(title: string | undefined, body: string | undefined): string[] {
  const head = [title ?? '', ...(body ?? '').split('\n').slice(0, 5)].join('\n');
  return [...new Set([...head.matchAll(LANE_REF)].map((m) => m[1]!.toUpperCase()))];
}

/**
 * The PR for a lane: by the lane's branch when it has one, else the newest PR that names the lane
 * id (full, or the 10-character prefix the board shows). Most seats never set a lane's branch, so
 * the id the PR body already carries is what usually matches.
 */
export function prForLane(
  prs: readonly ListedPr[],
  lane: { id: string; branch: string | null },
): ListedPr | undefined {
  if (lane.branch) {
    const byBranch = prs.find((p) => p.branch === lane.branch);
    if (byBranch) return byBranch;
  }
  const id = lane.id.toUpperCase();
  return prs.find((p) => p.lanes.some((ref) => id.startsWith(ref)));
}

/**
 * Every recent PR, newest first — ONE `gh` call per sweep rather than one per lane (ADR 779 §4), so
 * a team of twenty lanes costs one API request a minute. A fork's PR is left out: a stranger can
 * name its branch, or write a lane id in its body, as anything.
 */
export async function listPrs(
  repo: string,
  run: GhRunner = runGhList,
): Promise<ListedPr[] | { unknown: 'no_gh' | 'gh_error' }> {
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
      String(PR_LIST_LIMIT),
      '--json',
      'number,headRefName,state,statusCheckRollup,url,isCrossRepository,title,body',
    ]);
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === 'ENOENT') return { unknown: 'no_gh' };
    const said = `${e.stderr ?? ''} ${e.message ?? ''}`.toLowerCase();
    if (said.includes('gh auth login') || said.includes('not logged')) return { unknown: 'no_gh' };
    return { unknown: 'gh_error' };
  }
  try {
    const rows = JSON.parse(out) as Array<
      GhPr & { headRefName: string; url?: string; title?: string; body?: string }
    >;
    return rows
      .filter((r) => !r.isCrossRepository)
      .map((r): ListedPr => {
        const s = r.state.toUpperCase();
        return {
          number: r.number,
          branch: r.headRefName,
          state: s === 'MERGED' ? 'merged' : s === 'CLOSED' ? 'closed' : 'open',
          checks: rollupChecks(r.statusCheckRollup),
          url: r.url,
          lanes: laneRefs(r.title, r.body),
        };
      });
  } catch {
    return { unknown: 'gh_error' };
  }
}
