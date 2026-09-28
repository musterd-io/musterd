/**
 * cookoff git-archaeology — the git reference collector (ADR 123 / ADR 122 §5). Extracts
 * RepoFacts for the pure engine from git alone: no daemon, no musterd state. Actor identity is
 * git attribution (ADR 109): a `Co-authored-by: <seat> <seat@<team>.musterd>` trailer wins over
 * the author email, so seat identity survives the squash.
 */

import { execFileSync } from 'node:child_process';
import type { CommitFacts, DeletionProvenance, FileChange, RepoFacts } from './engine.js';

export interface ExtractOptions {
  repo: string;
  /** The kickoff commit — the pinned starting SHA; the window is everything after it. */
  start: string;
  /** The delivered ref (integration branch tip at run end). Default HEAD. */
  delivered?: string;
  /** Exclusion globs on repo-relative paths (lockfiles, dist, …). */
  exclude?: string[];
  /**
   * Which commits are in the window (ADR 462). `all` (the cookoff default): every ref reachable
   * after `start`. `pulls`: the delivered range plus the commits of the remote's retained PR heads
   * (`refs/pull/<n>/head`) authored at or after `start` — the population a shared multi-worktree
   * repo can reproduce from any checkout, and the one that tags every commit with its PR.
   */
  population?: 'all' | 'pulls';
  /** Remote whose PR heads `pulls` reads. Default `origin`. */
  remote?: string;
}

export interface PullHead {
  sha: string;
  pr: number;
  /**
   * The PR is still open: GitHub keeps `refs/pull/<n>/merge` only while a PR is open (matched the
   * open-PR list exactly on the dogfood repo, 2026-09-28). An open PR is work in flight — a live
   * repo has no run end, so it is neither delivered nor abandoned yet (ADR 462).
   */
  open: boolean;
}

/** The remote's retained PR heads, with which of them are still open, in one `ls-remote`. */
export function listPullHeads(repo: string, remote = 'origin'): PullHead[] {
  const out = git(['ls-remote', remote, 'refs/pull/*/head', 'refs/pull/*/merge'], repo);
  const open = new Set<number>();
  for (const m of out.matchAll(/\trefs\/pull\/(\d+)\/merge$/gm)) open.add(Number(m[1]!));
  const heads: PullHead[] = [];
  for (const m of out.matchAll(/^([0-9a-f]{40})\trefs\/pull\/(\d+)\/head$/gm)) {
    const pr = Number(m[2]!);
    heads.push({ sha: m[1]!, pr, open: open.has(pr) });
  }
  return heads;
}

/**
 * Fetch the objects of any PR head this clone lacks, by sha, writing no ref and no FETCH_HEAD:
 * a ref namespace in a repo whose `.git` every seat's worktree shares would put 1,700 heads into
 * everyone's `git log --all`.
 */
export function fetchMissing(repo: string, remote: string, shas: string[]): void {
  if (shas.length === 0) return;
  const check = git(['cat-file', '--batch-check'], repo, shas.join('\n') + '\n');
  const missing = [...check.matchAll(/^([0-9a-f]{40}) missing$/gm)].map((m) => m[1]!);
  if (missing.length === 0) return;
  git(['fetch', '-q', '--no-write-fetch-head', '--stdin', remote], repo, missing.join('\n') + '\n');
}

/** The `(#<n>)` a squash merge appends to its subject; null when the subject carries none. */
export function prFromSubject(body: string): number | null {
  const subject = body.split('\n', 1)[0] ?? '';
  const m = /\(#(\d+)\)\s*$/.exec(subject);
  return m ? Number(m[1]) : null;
}

export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/dist/**',
  '**/*.lock',
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/yarn.lock',
  '**/*.snap',
];

function git(args: string[], cwd: string, input?: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', input, maxBuffer: 256 * 1024 * 1024 });
}

/** Minimal glob → RegExp: `**` any path, `*` any segment chars. Anchored both ends. */
export function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    if (glob.startsWith('**/', i)) {
      out += '(?:.*/)?';
      i += 3;
    } else if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (glob[i] === '*') {
      out += '[^/]*';
      i += 1;
    } else {
      const ch = glob[i]!;
      out += /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

interface ParsedDiff {
  files: FileChange[];
  /** Pre-image deleted line numbers per path (against the first parent). */
  deleted: Map<string, number[]>;
}

/** Parse `--unified=0 --no-renames` diff text into added/deleted lines with line numbers. */
export function parseDiff(text: string, excluded: (path: string) => boolean): ParsedDiff {
  const files: FileChange[] = [];
  const deleted = new Map<string, number[]>();
  let path: string | null = null;
  let cur: FileChange | null = null;
  let oldN = 0;
  let newN = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      path = p === '/dev/null' ? path : p.replace(/^b\//, '');
      if (path !== null && !excluded(path)) {
        cur = { path, added: [] };
        files.push(cur);
      } else {
        cur = null;
      }
      continue;
    }
    if (line.startsWith('--- ')) {
      const p = line.slice(4);
      path = p === '/dev/null' ? null : p.replace(/^a\//, '');
      continue;
    }
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldN = Number(hunk[1]);
      newN = Number(hunk[2]);
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      cur?.added.push({ n: newN, text: line.slice(1) });
      newN += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      if (cur !== null && path !== null) {
        const arr = deleted.get(path) ?? [];
        arr.push(oldN);
        deleted.set(path, arr);
      }
      oldN += 1;
    }
  }
  return { files, deleted };
}

/** Seat trailer email beats author email (ADR 109 — the trailer survives the squash). */
export function resolveActor(authorEmail: string, body: string): string {
  for (const m of body.matchAll(/^Co-authored-by:.*<([^>]+)>\s*$/gim)) {
    if (m[1] !== undefined && /\.musterd$/i.test(m[1])) return m[1].toLowerCase();
  }
  return authorEmail.toLowerCase();
}

const SEP = '\x00';

/** Extract RepoFacts for the engine. Read-only; every fact comes from git plumbing. */
export function extractFacts(opts: ExtractOptions): RepoFacts {
  const { repo, start } = opts;
  const delivered = opts.delivered ?? 'HEAD';
  const regexes = (opts.exclude ?? DEFAULT_EXCLUDES).map(globToRegExp);
  const excluded = (p: string): boolean => regexes.some((r) => r.test(p));

  const deliveredShas = git(['rev-list', delivered, '--not', start], repo)
    .split('\n')
    .filter(Boolean);
  const deliveredSet = new Set(deliveredShas);
  // A PR-head commit's PR. Lowest PR wins when stacked heads share a commit: the earlier PR is
  // the one that authored it.
  const pullPr = new Map<string, number>();
  const inFlightPrs: number[] = [];
  let windowShas: string[];
  if (opts.population === 'pulls') {
    const remote = opts.remote ?? 'origin';
    const heads = listPullHeads(repo, remote).sort((a, b) => a.pr - b.pr);
    fetchMissing(
      repo,
      remote,
      heads.map((h) => h.sha),
    );
    // Squash merges never make a branch an ancestor of main, so `--not start` cannot bound a PR
    // head's history: the window is bounded by commit time instead, from `start`'s own.
    // ISO, not the bare epoch: git's date parser reads a short integer as something else.
    const since = new Date(
      Number(git(['show', '-s', '--format=%ct', start], repo).trim()) * 1000,
    ).toISOString();
    const inWindow = new Set(
      git(
        ['rev-list', '--stdin', '--no-walk', `--since=${since}`],
        repo,
        heads.map((h) => h.sha).join('\n') + '\n',
      )
        .split('\n')
        .filter(Boolean),
    );
    for (const h of heads) {
      if (!inWindow.has(h.sha)) continue;
      if (h.open) {
        inFlightPrs.push(h.pr);
        continue;
      }
      const own = git(['rev-list', `--since=${since}`, h.sha, '--not', delivered, start], repo)
        .split('\n')
        .filter(Boolean);
      for (const sha of own) if (!pullPr.has(sha)) pullPr.set(sha, h.pr);
    }
    windowShas = [...deliveredShas, ...pullPr.keys()];
  } else {
    windowShas = git(['rev-list', '--all', '--not', start], repo).split('\n').filter(Boolean);
  }

  const windowSet = new Set(windowShas);
  const commits: CommitFacts[] = [];
  const deletions: DeletionProvenance[] = [];

  for (const sha of windowShas) {
    const meta = git(['show', '-s', '--format=%ae%x00%ct%x00%P%x00%B', sha], repo);
    const [ae = '', ct = '', parents = '', ...bodyParts] = meta.split(SEP);
    const body = bodyParts.join(SEP);
    const parentList = parents.trim().split(' ').filter(Boolean);
    const merge = parentList.length > 1;
    const actor = resolveActor(ae.trim(), body);
    const order = Number(ct.trim());

    let files: FileChange[] = [];
    let patchId: string | null = null;

    if (!merge) {
      const diffText = git(
        ['show', sha, '--format=', '--unified=0', '--no-renames', '--no-color'],
        repo,
      );
      const parsed = parseDiff(diffText, excluded);
      files = parsed.files.filter((f) => f.added.length > 0);
      if (diffText.trim() !== '') {
        const out = git(['patch-id', '--stable'], repo, diffText);
        patchId = out.split(' ')[0]?.trim() || null;
      }
      // W2 provenance: blame each deleted line of a *delivered* commit against its first parent.
      if (deliveredSet.has(sha) && parentList.length === 1) {
        for (const [path, nums] of parsed.deleted) {
          for (const range of toRanges(nums)) {
            let blame = '';
            try {
              blame = git(
                ['blame', '--porcelain', '-L', `${range[0]},${range[1]}`, `${sha}^`, '--', path],
                repo,
              );
            } catch {
              continue; // path absent in the parent (rename/mode edge) — skip, warn-never-block
            }
            for (const m of blame.matchAll(/^([0-9a-f]{40}) (\d+) \d+(?: \d+)?$/gm)) {
              const srcSha = m[1]!;
              if (windowSet.has(srcSha) && srcSha !== sha) {
                deletions.push({ delSha: sha, srcSha, path, srcLine: Number(m[2]!) });
              }
            }
          }
        }
      }
    } else if (deliveredSet.has(sha)) {
      // W4: replay the auto-merge and diff it against the actual merge result.
      try {
        const auto = git(['merge-tree', '--write-tree', parentList[0]!, parentList[1]!], repo)
          .split('\n')[0]!
          .trim();
        const delta = git(
          ['diff', '--unified=0', '--no-renames', '--no-color', auto, `${sha}^{tree}`],
          repo,
        );
        files = parseDiff(delta, excluded).files.filter((f) => f.added.length > 0);
      } catch {
        // merge-tree exits non-zero on conflicts but still prints the tree on stdout; older git
        // lacks --write-tree entirely. Either way: no churn data beats a crash.
        files = [];
      }
    }

    const pr = deliveredSet.has(sha) ? prFromSubject(body) : (pullPr.get(sha) ?? null);
    commits.push({
      sha,
      actor,
      order,
      delivered: deliveredSet.has(sha),
      patchId,
      files,
      merge,
      ...(pr !== null ? { pr } : {}),
    });
  }

  const ancestryCache = new Map<string, boolean>();
  const isAncestor = (a: string, b: string): boolean => {
    const k = `${a} ${b}`;
    const hit = ancestryCache.get(k);
    if (hit !== undefined) return hit;
    let v = false;
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', a, b], { cwd: repo });
      v = true;
    } catch {
      v = false;
    }
    ancestryCache.set(k, v);
    return v;
  };

  return {
    commits,
    deletions,
    isAncestor,
    ...(opts.population === 'pulls' ? { inFlightPrs } : {}),
  };
}

/** Collapse sorted line numbers into inclusive [from,to] ranges for batched blame calls. */
export function toRanges(nums: number[]): Array<[number, number]> {
  const sorted = [...nums].sort((a, b) => a - b);
  const out: Array<[number, number]> = [];
  for (const n of sorted) {
    const last = out[out.length - 1];
    if (last && n === last[1] + 1) last[1] = n;
    else if (!last || n > last[1]) out.push([n, n]);
  }
  return out;
}
