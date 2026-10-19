/**
 * `pnpm train notes [vPREV..HEAD] --version X.Y.Z` — draft the release notes for a version
 * (ADR 669 D5): every squash-merged PR since the last tag, grouped by the goal its lane serves,
 * with the PRs a user cannot notice left out. The draft lands at `docs/releases/vX.md`; a human
 * edits it down to what a user would notice (sloane owns the voice, nick edits), and the edited file
 * is the GitHub Release body. There is no CHANGELOG.md beside it — one fact, one home.
 *
 * What counts as "a user cannot notice it": a commit whose every changed file is docs (`docs/**`,
 * any `.md`), tests (`*.test.*`, `tests/**`) or CI (`.github/**`). Everything else stays in the
 * draft, because cutting it is the editor's call, not the script's.
 */
import { execFileSync } from 'node:child_process';

export interface Commit {
  sha: string;
  subject: string;
  files: string[];
}

export interface NoteEntry {
  title: string;
  pr: number | null;
  lane: string | null;
}

/** A path a user never sees in the product. */
export function isInvisiblePath(path: string): boolean {
  return (
    path.startsWith('docs/') ||
    path.startsWith('.github/') ||
    path.startsWith('tests/') ||
    path.endsWith('.md') ||
    /\.test\.[cm]?[jt]sx?$/.test(path)
  );
}

export function userVisible(commit: Commit): boolean {
  return commit.files.length > 0 && !commit.files.every(isInvisiblePath);
}

/**
 * "Fix the thing (lane 01M5AXB5NZ) (#2939)" → title "Fix the thing", pr 2939, lane 01M5AXB5NZ.
 * Lane ids appear short (10 chars) or full (26); both resolve on the board.
 */
export function parseSubject(subject: string): NoteEntry {
  const pr = /\(#(\d+)\)\s*$/.exec(subject);
  const lane = /\(lane ([0-9A-Z]{10,26})[,)]/i.exec(subject);
  const title = subject
    .replace(/\s*\(#\d+\)\s*$/, '')
    .replace(/\s*\(lane [0-9A-Z]{10,26}\)/i, '')
    .trim();
  return { title, pr: pr ? Number(pr[1]) : null, lane: lane ? lane[1]!.toUpperCase() : null };
}

/** Lane id → goal id, or null when the board cannot say (no daemon, unknown lane, no goal). */
export type GoalOf = (lane: string) => string | null;

export function groupByGoal(entries: NoteEntry[], goalOf: GoalOf): Map<string, NoteEntry[]> {
  const groups = new Map<string, NoteEntry[]>();
  for (const e of entries) {
    const goal = (e.lane && goalOf(e.lane)) || 'other';
    groups.set(goal, [...(groups.get(goal) ?? []), e]);
  }
  return groups;
}

export function renderNotes(
  version: string,
  range: string,
  groups: Map<string, NoteEntry[]>,
  dropped: number,
): string {
  const repo = 'https://github.com/musterd-io/musterd';
  const sections = [...groups.entries()]
    .sort(([a], [b]) => (a === 'other' ? 1 : b === 'other' ? -1 : a.localeCompare(b)))
    .map(([goal, entries]) => {
      const items = entries.map(
        (e) => `- ${e.title}${e.pr ? ` ([#${e.pr}](${repo}/pull/${e.pr}))` : ''}`,
      );
      return [`### ${goal}`, '', ...items].join('\n');
    });
  return `# musterd v${version}

<!-- DRAFT from \`pnpm train notes ${range}\`. Edit it down to the few things a user would notice,
     in plain words, then delete this comment. The edited file is the GitHub Release body (ADR 669).
     ${dropped} docs/test/CI-only commit${dropped === 1 ? '' : 's'} left out. -->

## What's new

${sections.join('\n\n')}

## Install

\`\`\`bash
npm install -g @musterd/cli@${version}
\`\`\`
`;
}

// ── real I/O ────────────────────────────────────────────────────────────────────────────────────

const git = (...args: string[]) =>
  execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 64 * 1024 * 1024,
  });

export function commitsIn(range: string): Commit[] {
  const log = git('log', '--first-parent', '--format=%H%x1f%s', range).trim();
  if (!log) return [];
  return log.split('\n').map((line) => {
    const [sha, subject] = line.split('\x1f') as [string, string];
    const files = git('show', '--name-only', '--format=', sha).split('\n').filter(Boolean);
    return { sha, subject, files };
  });
}

export function latestTag(): string {
  return git('describe', '--tags', '--abbrev=0', '--match', 'v*').trim();
}

/** The board's answer, via the CLI (`musterd lane show <id> --json`); null if it cannot answer.
 *  Memoised: a release spans hundreds of commits but far fewer lanes. */
const goalCache = new Map<string, string | null>();
export const boardGoalOf: GoalOf = (lane) => {
  if (goalCache.has(lane)) return goalCache.get(lane)!;
  const goal = lookupGoal(lane);
  goalCache.set(lane, goal);
  return goal;
};

function lookupGoal(lane: string): string | null {
  try {
    const out = execFileSync('musterd', ['lane', 'show', lane, '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
    });
    return (JSON.parse(out) as { lane?: { goal_id?: string | null } }).lane?.goal_id ?? null;
  } catch {
    return null;
  }
}
