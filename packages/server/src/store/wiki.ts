import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  WIKI_MAX_PAGE_BYTES,
  WIKI_MAX_PAGES,
  wikiPathProblem,
  wikiRepoProblem,
  type WikiIndex,
  type WikiPage,
  type WikiPageEntry,
  type WikiSource,
} from '@musterd/protocol';
import { log } from '../log.js';

/**
 * ADR 747: a Team's wiki, read from its repo's default branch with `git`.
 *
 * The repo is the one source of truth; what this module keeps on disk is a cache it can throw away.
 * Per source, a shallow, blobless clone with a sparse checkout of just the wiki folder — one batched
 * fetch brings down only that folder's files (measured on this repo, 2026-10-28: 137 pages, 1.8 s
 * cold, 0.4 s to update, 1.3 MB on disk). A read is served from the cache; at most every
 * {@link WIKI_CHECK_INTERVAL_MS} a read also asks the remote (`ls-remote`) whether the branch moved,
 * behind the response, and fetches only when it did. Only the very first read waits on the network.
 *
 * The URL is typed by a Team admin and run through `git`, so every call is boxed: the protocol
 * schema admits only https/ssh URLs, `GIT_ALLOW_PROTOCOL` holds the same line inside git, and no
 * system or global config, credential helper or SSH agent is reachable — a Team cannot borrow this
 * host's access to someone else's private repo. Symlinks are checked out as plain files, and a page
 * is read only if it is a regular file inside the cache.
 */

const execFileAsync = promisify(execFile);

/** How long one `git` call may run — the same bound `sync/rosterRefresh.ts` gives its pull. */
export const WIKI_GIT_TIMEOUT_MS = 20_000;

/** How stale a cached read may be before the next read asks the remote whether it moved. */
export const WIKI_CHECK_INTERVAL_MS = 5 * 60_000;

export type GitRunner = (args: string[], cwd?: string) => Promise<string>;

/** `git` with nothing of this host's configuration or credentials reachable. */
export const boxedGit: GitRunner = async (args, cwd) => {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: process.env['HOME'] ?? '/',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https:ssh',
    GIT_SSH_COMMAND:
      'ssh -F /dev/null -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityAgent=none',
  };
  const { stdout } = await execFileAsync(
    'git',
    [
      ...(cwd ? ['-C', cwd] : []),
      '-c',
      'credential.helper=',
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { encoding: 'utf8', timeout: WIKI_GIT_TIMEOUT_MS, env, maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout;
};

function firstLine(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown; killed?: boolean };
  if (e.killed) return `git timed out after ${WIKI_GIT_TIMEOUT_MS / 1000} s`;
  const text =
    typeof e.stderr === 'string' && e.stderr.trim() !== ''
      ? e.stderr
      : typeof e.message === 'string'
        ? e.message
        : String(err);
  return (
    text
      .trim()
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? 'git failed'
  );
}

/** A heading as plain text: `code`, **strong**, _emphasis_ and [links](…) keep only their words. */
function plainTitle(md: string): string {
  return (
    md
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|\W)[*_](.+?)[*_](?=\W|$)/g, '$1$2')
      .trim() || md
  );
}

/** The page's first `# ` heading as plain text, else its file name without `.md`. */
export function wikiTitle(path: string, markdown: string): string {
  let fenced = false;
  for (const line of markdown.split('\n', 400)) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    const m = /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return plainTitle(m[1]!);
  }
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.md$/i, '');
}

interface SourceState {
  dir: string;
  branch: string | null;
  commit: string | null;
  /** The index at `commit`, built once per commit. */
  index: { pages: WikiPageEntry[]; truncated: boolean } | null;
  checkedAt: number;
  /** The last check failed; what is served is the last good read. */
  failed: string | null;
  inflight: Promise<void> | null;
}

export interface WikiReader {
  index(teamId: string, source: WikiSource): Promise<WikiIndex>;
  /** One page's markdown, or null when no such page is in the index. */
  page(teamId: string, source: WikiSource, path: string): Promise<WikiPage | null>;
}

export interface WikiReaderOptions {
  /** The cache root; each source gets a folder under it. */
  root: string;
  git?: GitRunner;
  now?: () => number;
}

export function createWikiReader(opts: WikiReaderOptions): WikiReader {
  const git = opts.git ?? boxedGit;
  const now = opts.now ?? Date.now;
  const states = new Map<string, SourceState>();

  function stateFor(teamId: string, source: WikiSource): SourceState {
    const key = `${teamId}\n${source.repo}\n${source.path}`;
    let st = states.get(key);
    if (!st) {
      const id = createHash('sha256').update(key).digest('hex').slice(0, 20);
      st = {
        dir: join(opts.root, id),
        branch: null,
        commit: null,
        index: null,
        checkedAt: 0,
        failed: null,
        inflight: null,
      };
      states.set(key, st);
    }
    return st;
  }

  /** Ask the remote where its default branch is; fetch and check out only when it moved. */
  async function refresh(teamId: string, source: WikiSource, st: SourceState): Promise<void> {
    const started = now();
    try {
      const head = await git(['ls-remote', '--symref', '--', source.repo, 'HEAD']);
      const branch = /^ref: refs\/heads\/(\S+)\s+HEAD$/m.exec(head)?.[1];
      const sha = /^([0-9a-f]{40,64})\s+HEAD$/m.exec(head)?.[1];
      if (!branch || !sha) throw new Error('the repo has no default branch');
      st.checkedAt = now();
      if (sha === st.commit) {
        st.failed = null;
        return;
      }
      if (!existsSync(join(st.dir, '.git'))) {
        await rm(st.dir, { recursive: true, force: true });
        await mkdir(opts.root, { recursive: true });
        await git([
          'clone',
          '--quiet',
          '--depth',
          '1',
          '--filter=blob:none',
          '--no-checkout',
          '--branch',
          branch,
          '--',
          source.repo,
          st.dir,
        ]);
        await git(['config', 'core.symlinks', 'false'], st.dir);
        const pattern = source.path === '' ? '/*' : `/${source.path}/`;
        await git(['sparse-checkout', 'set', '--no-cone', pattern], st.dir);
        await git(['checkout', '--quiet', '--force', branch], st.dir);
      } else {
        await git(
          ['fetch', '--quiet', '--depth', '1', '--filter=blob:none', 'origin', branch],
          st.dir,
        );
        await git(['reset', '--quiet', '--hard', 'FETCH_HEAD'], st.dir);
      }
      st.commit = (await git(['rev-parse', 'HEAD'], st.dir)).trim();
      st.branch = branch;
      st.index = await buildIndex(st.dir, source.path);
      st.failed = null;
      log.info({ msg: 'wiki_fetch', team: teamId, outcome: 'fetched', ms: now() - started });
    } catch (err) {
      st.checkedAt = now();
      st.failed = firstLine(err);
      log.warn({
        msg: 'wiki_fetch',
        team: teamId,
        outcome: 'failed',
        ms: now() - started,
        detail: st.failed,
      });
    }
  }

  function kick(teamId: string, source: WikiSource, st: SourceState): Promise<void> {
    if (!st.inflight) {
      st.inflight = refresh(teamId, source, st).finally(() => {
        st.inflight = null;
      });
    }
    return st.inflight;
  }

  async function ready(teamId: string, source: WikiSource): Promise<SourceState> {
    const st = stateFor(teamId, source);
    if (st.commit === null) await kick(teamId, source, st);
    else if (now() - st.checkedAt >= WIKI_CHECK_INTERVAL_MS) void kick(teamId, source, st);
    return st;
  }

  return {
    async index(teamId, source) {
      const problem = wikiSourceProblem(source);
      if (problem)
        return { state: 'failed', repo: source.repo, path: source.path, detail: problem };
      const st = await ready(teamId, source);
      if (st.commit === null || st.index === null) {
        return {
          state: 'failed',
          repo: source.repo,
          path: source.path,
          detail: st.failed ?? 'the wiki has not been read yet',
        };
      }
      return {
        state: 'ready',
        repo: source.repo,
        path: source.path,
        commit: st.commit,
        branch: st.branch ?? 'main',
        pages: st.index.pages,
        truncated: st.index.truncated,
        stale: st.failed !== null,
      };
    },
    async page(teamId, source, path) {
      if (wikiSourceProblem(source)) return null;
      const st = await ready(teamId, source);
      if (st.commit === null || st.index === null) return null;
      const entry = st.index.pages.find((p) => p.path === path);
      if (!entry || entry.bytes > WIKI_MAX_PAGE_BYTES) return null;
      const markdown = await readPage(st.dir, source.path, path);
      return markdown === null ? null : { path, commit: st.commit, markdown };
    },
  };
}

/** A regular file inside the wiki folder, or null: never a symlink, never outside the cache. */
async function readPage(dir: string, folder: string, path: string): Promise<string | null> {
  if (wikiPathProblem(path) || !path.toLowerCase().endsWith('.md')) return null;
  const base = join(dir, folder);
  const file = join(base, path);
  const rel = relative(base, file);
  if (rel === '' || rel.startsWith('..') || rel.split(sep).includes('..')) return null;
  try {
    const st = await lstat(file);
    if (!st.isFile() || st.size > WIKI_MAX_PAGE_BYTES) return null;
    return await readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function buildIndex(
  dir: string,
  folder: string,
): Promise<{ pages: WikiPageEntry[]; truncated: boolean }> {
  const base = join(dir, folder);
  const found: string[] = [];
  let truncated = false;
  async function walk(at: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (found.length >= WIKI_MAX_PAGES) {
        truncated = true;
        return;
      }
      if (e.name.startsWith('.')) continue;
      const full = join(at, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) found.push(full);
    }
  }
  await walk(base);
  const pages: WikiPageEntry[] = [];
  for (const full of found) {
    const path = relative(base, full).split(sep).join('/');
    const st = await lstat(full);
    const head =
      st.size > WIKI_MAX_PAGE_BYTES ? '' : (await readFile(full, 'utf8')).slice(0, 16_000);
    pages.push({ path, title: wikiTitle(path, head), bytes: st.size });
  }
  pages.sort((a, b) => a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }));
  return { pages, truncated };
}

/** Why a source cannot be read at all, before any git runs — a defence behind the schema's. */
export function wikiSourceProblem(source: WikiSource): string | null {
  return wikiRepoProblem(source.repo) ?? wikiPathProblem(source.path);
}

const shared = new Map<string, WikiReader>();

/** The daemon's one reader per cache root: `wiki-cache/` beside the coordination store. */
export function sharedWikiReader(dbPath: string): WikiReader {
  const root =
    dbPath === ':memory:'
      ? join(tmpdir(), `musterd-wiki-${process.pid}`)
      : join(dirname(dbPath), 'wiki-cache');
  let reader = shared.get(root);
  if (!reader) {
    reader = createWikiReader({ root });
    shared.set(root, reader);
  }
  return reader;
}
