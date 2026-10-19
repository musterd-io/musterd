import { execFileSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBinding } from '../config.js';
import { bindingRefusal } from './guard.js';

/**
 * Repo suggestions for `musterd init`'s connect path (lane 01M4FDBVGB): the folders each harness has
 * already recorded working in, read from its own store. Read-only and never throws — a harness
 * whose file is missing or unreadable contributes nothing. The Claude Code, Codex, Cursor and Grok
 * formats were checked on a real machine on 2026-10-11; opencode's was checked on 2026-10-19 (lane
 * 01M4PHMBGY: opencode migrated from `storage/project/*.json` to `opencode.db`'s `project` table, so
 * the reader reads `opencode.db` first and falls back to the pre-SQLite JSON files).
 */
export interface FolderSeen {
  dir: string;
  /** Epoch ms. */
  at: number;
}

export interface RecentRepo {
  dir: string;
  harnesses: string[];
  lastUsed: number;
}

const CWD_RE = /"cwd":("(?:[^"\\]|\\.)*")/;
/** Codex keeps every session forever; reading the newest few hundred is plenty for "recent". */
const CODEX_SESSION_CAP = 200;

function safe(fn: () => FolderSeen[]): FolderSeen[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function ls(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/** The first `"cwd":"…"` in the first `bytes` of a JSONL file, or null. */
function cwdIn(path: string, bytes: number): string | null {
  try {
    const fd = openSync(path, 'r');
    try {
      const buf = Buffer.alloc(bytes);
      const n = readSync(fd, buf, 0, bytes, 0);
      const m = CWD_RE.exec(buf.subarray(0, n).toString('utf8'));
      return m ? (JSON.parse(m[1]!) as string) : null;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

const mtime = (path: string) => Math.round(statSync(path).mtimeMs);

/** `~/.claude/projects/<encoded>/<session>.jsonl` — the newest session per project names its cwd. */
function claudeCode(home: string): FolderSeen[] {
  const root = join(home, '.claude', 'projects');
  const out: FolderSeen[] = [];
  for (const project of ls(root)) {
    const newest = ls(join(root, project))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(root, project, f))
      .map((path) => ({ path, at: mtime(path) }))
      .sort((a, b) => b.at - a.at)[0];
    if (!newest) continue;
    const dir = cwdIn(newest.path, 64 * 1024);
    if (dir) out.push({ dir, at: newest.at });
  }
  return out;
}

/** `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` — the first line's session_meta carries cwd. */
function codex(home: string): FolderSeen[] {
  const root = join(home, '.codex', 'sessions');
  const desc = (d: string) => ls(d).sort().reverse();
  const files: string[] = [];
  outer: for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m)))
        for (const f of desc(join(root, y, m, d))) {
          if (!f.endsWith('.jsonl')) continue;
          files.push(join(root, y, m, d, f));
          if (files.length >= CODEX_SESSION_CAP) break outer;
        }
  const out: FolderSeen[] = [];
  for (const path of files) {
    const dir = cwdIn(path, 4 * 1024);
    if (dir) out.push({ dir, at: mtime(path) });
  }
  return out;
}

function cursorUserDir(home: string): string {
  if (process.platform === 'darwin')
    return join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (process.platform === 'win32')
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  return join(home, '.config', 'Cursor', 'User');
}

/** Cursor's `workspaceStorage/<id>/workspace.json` names the opened folder as a URI. */
function cursor(home: string): FolderSeen[] {
  const root = join(cursorUserDir(home), 'workspaceStorage');
  const out: FolderSeen[] = [];
  for (const id of ls(root)) {
    try {
      const folder = (
        JSON.parse(readFileSync(join(root, id, 'workspace.json'), 'utf8')) as { folder?: unknown }
      ).folder;
      if (typeof folder !== 'string' || !folder.startsWith('file://')) continue;
      out.push({ dir: fileURLToPath(folder), at: mtime(join(root, id)) });
    } catch {
      // one unreadable workspace never hides the rest
    }
  }
  return out;
}

/** `~/.grok/trusted_folders.toml`: one `[folders."<path>"]` table per folder Grok was trusted in. */
function grok(home: string): FolderSeen[] {
  const body = readFileSync(join(home, '.grok', 'trusted_folders.toml'), 'utf8');
  const out: FolderSeen[] = [];
  for (const block of body.split(/^(?=\[folders\.)/m)) {
    const name = /^\[folders\.("(?:[^"\\]|\\.)*")\]/.exec(block);
    if (!name || !/^trusted\s*=\s*true\s*$/m.test(block)) continue;
    const at = /^decided_at\s*=\s*(\d+)\s*$/m.exec(block);
    out.push({ dir: JSON.parse(name[1]!) as string, at: at ? Number(at[1]) * 1000 : 0 });
  }
  return out;
}

/**
 * opencode keeps its projects in `~/.local/share/opencode/opencode.db` (`project` table: `worktree`,
 * `time_active`, `time_updated`, `time_created`; `/` is its global project). Pre-SQLite installs
 * wrote `storage/project/<id>.json` instead; read both so either version works.
 */
function opencode(home: string): FolderSeen[] {
  const out: FolderSeen[] = [];
  const dbPath = join(home, '.local', 'share', 'opencode', 'opencode.db');
  if (existsSync(dbPath)) {
    try {
      const raw = execFileSync(
        'sqlite3',
        [
          '-readonly',
          '-json',
          dbPath,
          "SELECT worktree AS dir, COALESCE(NULLIF(time_active, 0), time_updated, time_created) AS at FROM project WHERE worktree != '' AND worktree != '/';",
        ],
        { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
      ).trim();
      const rows = raw ? (JSON.parse(raw) as { dir?: unknown; at?: unknown }[]) : [];
      for (const r of rows) {
        if (typeof r.dir === 'string' && r.dir !== '' && r.dir !== '/') {
          out.push({
            dir: r.dir,
            at: typeof r.at === 'number' && Number.isFinite(r.at) ? Math.round(r.at) : 0,
          });
        }
      }
    } catch {
      // sqlite3 absent, schema without time_active, or corrupt db — try the basic columns, then files
      try {
        const raw = execFileSync(
          'sqlite3',
          [
            '-readonly',
            '-json',
            dbPath,
            "SELECT worktree AS dir, COALESCE(time_updated, time_created) AS at FROM project WHERE worktree != '' AND worktree != '/';",
          ],
          { encoding: 'utf8', timeout: 1000, stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
        const rows = raw ? (JSON.parse(raw) as { dir?: unknown; at?: unknown }[]) : [];
        for (const r of rows) {
          if (typeof r.dir === 'string' && r.dir !== '' && r.dir !== '/') {
            out.push({
              dir: r.dir,
              at: typeof r.at === 'number' && Number.isFinite(r.at) ? Math.round(r.at) : 0,
            });
          }
        }
      } catch {
        // fall through to storage/project/*.json
      }
    }
  }
  const root = join(home, '.local', 'share', 'opencode', 'storage', 'project');
  for (const f of ls(root)) {
    if (!f.endsWith('.json')) continue;
    const path = join(root, f);
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as {
        worktree?: unknown;
        time?: { updated?: unknown; created?: unknown };
      };
      const wt = parsed.worktree;
      if (typeof wt === 'string' && wt !== '' && wt !== '/') {
        const t = parsed.time?.updated ?? parsed.time?.created;
        out.push({
          dir: wt,
          at: typeof t === 'number' && Number.isFinite(t) ? Math.round(t) : mtime(path),
        });
      }
    } catch {
      // skip a corrupt project file
    }
  }
  return out;
}

/** One reader per harness id; a harness with none (the native host) suggests nothing. */
export const RECENT_READERS: Record<string, (home: string) => FolderSeen[]> = {
  'claude-code': (h) => safe(() => claudeCode(h)),
  codex: (h) => safe(() => codex(h)),
  cursor: (h) => safe(() => cursor(h)),
  grok: (h) => safe(() => grok(h)),
  opencode: (h) => safe(() => opencode(h)),
};

export interface RecentReposOptions {
  home: string;
  harnessIds: string[];
  /** Default 8. */
  limit?: number;
  /** Folders to leave out (this folder, which the picker lists itself). */
  exclude?: string[];
  gitRoot?: (dir: string) => string | null;
  isBound?: (dir: string) => boolean;
  isRefused?: (dir: string) => boolean;
  tmpRoots?: string[];
}

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function defaultGitRoot(dir: string): string | null {
  try {
    return (
      execFileSync('git', ['rev-parse', '--show-toplevel'], {
        cwd: dir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() || null
    );
  } catch {
    return null;
  }
}

const under = (dir: string, root: string) => dir === root || dir.startsWith(root + sep);

/**
 * The repos worth offering, most recently used first: each recorded folder mapped to its git root
 * and merged across harnesses, minus folders that are gone, under a temp directory, already bound to
 * a seat, or refused a binding (`~`, a folder above a Workspace).
 */
export function recentRepos(opts: RecentReposOptions): RecentRepo[] {
  const gitRoot = opts.gitRoot ?? defaultGitRoot;
  const isBound = opts.isBound ?? ((d: string) => loadBinding(d).kind !== 'missing');
  const isRefused = opts.isRefused ?? ((d: string) => bindingRefusal(d, opts.home) !== null);
  const tmpRoots = (opts.tmpRoots ?? [tmpdir(), '/tmp', '/private/tmp', '/var/folders']).map(real);
  const exclude = new Set((opts.exclude ?? []).map(real));
  const byDir = new Map<string, RecentRepo>();
  const rootOf = new Map<string, string>();

  for (const id of opts.harnessIds) {
    const reader = RECENT_READERS[id];
    if (!reader) continue;
    for (const seen of reader(opts.home)) {
      if (!existsSync(seen.dir)) continue;
      const here = real(seen.dir);
      if (tmpRoots.some((t) => under(here, t))) continue;
      let dir = rootOf.get(here);
      if (dir === undefined) {
        dir = real(gitRoot(here) ?? here);
        rootOf.set(here, dir);
      }
      const row = byDir.get(dir) ?? { dir, harnesses: [], lastUsed: 0 };
      if (!row.harnesses.includes(id)) row.harnesses.push(id);
      row.lastUsed = Math.max(row.lastUsed, seen.at);
      byDir.set(dir, row);
    }
  }

  return [...byDir.values()]
    .filter((r) => !exclude.has(r.dir) && !isBound(r.dir) && !isRefused(r.dir))
    .sort((a, b) => b.lastUsed - a.lastUsed)
    .slice(0, opts.limit ?? 8);
}
