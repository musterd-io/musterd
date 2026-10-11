# First run: connect the agents you already have — Implementation Plan

> **Execution:** stanley implements this in its own seat, task by task (AGENTS.md hard rule 8: no
> writing subagents). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `musterd init` gains a default "Connect the agents you already have" path that, in one
run, gives every repo the person picks its own seat with every installed harness wired.

**Architecture:** Two new units under `packages/cli/src/onboard/`. `recents.ts` reads the folders
each harness has recorded (read-only, plain files) and turns them into repo suggestions. `connect.ts`
holds a pure core (`seatNameFor`, `connectRepos`, `resultLine`) and a thin `@clack/prompts` layer
(`runConnect`). Per repo it calls the existing `provisionAgentSeat({ here: true, sourceDir })`, then
`upsertPrimer`. `init.ts` only gains the menu option and the hand-off.

**Tech Stack:** TypeScript on Node ≥22, `@clack/prompts` (existing CLI dependency), Vitest.

**Spec:** `docs/superpowers/specs/2026-10-11-first-run-connect-design.md`

## Increments

| # | Increment | Lane |
| --- | --- | --- |
| 1 | Repo suggestions from harness records (Task 1) | `01M4FDBVGB` |
| 2 | Connect core and the init menu (Tasks 2–3) | `01M4FDBVGB` |
| 3 | ADR, CLI doc, terminal frames (Task 4) | `01M4FDBVGB` |

## Global Constraints

- No new runtime dependency (AGENTS.md hard rule 6). TOML and JSONL are read with regex/JSON.parse.
- Recents readers are read-only and never throw; any error yields `[]`.
- At most 8 suggestions; this folder is always listed first and preselected.
- Seat names contain no whitespace (`packages/protocol/src/seatfile.ts` `NAME_RE = /^\S+$/`).
- `provisionSeat` always writes `autojoin: true`; the connect path asks no join question, no role,
  no toolkit (toolkit `''`).
- A failing repo never stops the others; exit code is 1 if any repo failed.
- Existing init paths ("Add a new agent", "Activate an existing member", "Just me") behave exactly as
  before.
- Locally run only the new test files and the fast gates (`pnpm typecheck && pnpm lint &&
  pnpm format:check`); CI runs the suite.

## Review Focus

1. **A harness record names a subfolder of a repo** (Claude run in `~/code/api/packages/x`) — expect
   one suggestion, `~/code/api`. Pinned in Task 1 (`maps a subfolder to its git root`).
2. **A huge Codex sessions tree** (thousands of rollouts) — expect init to stay fast: only the newest
   200 files are read. Pinned in Task 1 (`reads only the newest 200 codex sessions`).
3. **This folder is not a git repo, or is refused** (`~`) — expect it to drop out of the list and the
   picker to still work. Pinned in Task 1 (`keeps a non-git folder as itself`) and Task 3 (`refused cwd
   is not offered`).
4. **Two picked repos share a folder name** (`~/a/web`, `~/b/web`) — expect `web` and `web-2`, not a
   conflict error. Pinned in Task 2 (`names two same-named repos web and web-2`).
5. **Person picks no repos** — expect a clear "nothing connected" outro and exit 0, no seats made.
   Pinned in Task 3 (`no repos picked connects nothing`).

---

### Task 1: Repo suggestions from harness records

**Files:**
- Create: `packages/cli/src/onboard/recents.ts`
- Test: `packages/cli/src/onboard/recents.test.ts`

**Interfaces:**
- Consumes: `bindingRefusal(cwd, home)` from `./guard.js`; `loadBinding(dir)` from `../config.js`
  (`.kind === 'missing'` means unbound).
- Produces:
  ```ts
  export interface FolderSeen { dir: string; at: number } // at = epoch ms
  export interface RecentRepo { dir: string; harnesses: string[]; lastUsed: number }
  export const RECENT_READERS: Record<string, (home: string) => FolderSeen[]>; // keyed by harness id
  export interface RecentReposOptions {
    home: string;
    harnessIds: string[];
    limit?: number;                          // default 8
    exclude?: string[];                      // real paths to leave out (this folder)
    gitRoot?: (dir: string) => string | null; // default: `git rev-parse --show-toplevel`
    isBound?: (dir: string) => boolean;       // default: loadBinding(dir).kind !== 'missing'
    isRefused?: (dir: string) => boolean;     // default: bindingRefusal(dir, home) !== null
    tmpRoots?: string[];                      // default: [realpath(os.tmpdir()), '/tmp', '/private/tmp', '/var/folders']
  }
  export function recentRepos(opts: RecentReposOptions): RecentRepo[];
  ```

Readers (each wrapped in try/catch → `[]`):

| id | Read | `at` |
| --- | --- | --- |
| `claude-code` | for each dir in `<home>/.claude/projects/`, the newest `*.jsonl`; first 64 KiB; first `"cwd":"…"` | file mtime |
| `codex` | `<home>/.codex/sessions/YYYY/MM/DD/*.jsonl`, newest 200 by path (dirs sorted descending); first 4 KiB; first `"cwd":"…"` | file mtime |
| `cursor` | `<cursorUser>/workspaceStorage/*/workspace.json` → `folder` (`file://` URI only) | dir mtime |
| `grok` | `<home>/.grok/trusted_folders.toml` → `[folders."<path>"]` blocks with `trusted = true` | `decided_at` × 1000 |
| `opencode` | `<home>/.local/share/opencode/storage/project/*.json` → `worktree` (skip `/`) | file mtime |

`cursorUser`: darwin `<home>/Library/Application Support/Cursor/User`; win32
`%APPDATA%/Cursor/User`; else `<home>/.config/Cursor/User`.

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { RECENT_READERS, recentRepos } from './recents.js';

let home: string;
const T = (s: number) => new Date(s * 1000);
function put(path: string, body: string, mtimeSec?: number) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
  if (mtimeSec !== undefined) utimesSync(path, T(mtimeSec), T(mtimeSec));
}
// Fixture repos live outside tmpRoots by construction: tests pass tmpRoots: [] and a fake gitRoot.
const base = { gitRoot: (d: string) => d, isBound: () => false, isRefused: () => false, tmpRoots: [] };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'recents-'));
});

describe('RECENT_READERS', () => {
  it('claude-code reads cwd from the newest jsonl per project', () => {
    put(join(home, '.claude/projects/-a/old.jsonl'), '{"cwd":"/old"}\n', 100);
    put(join(home, '.claude/projects/-a/new.jsonl'), '{"type":"x"}\n{"cwd":"/code/api"}\n', 200);
    expect(RECENT_READERS['claude-code']!(home)).toEqual([{ dir: '/code/api', at: 200_000 }]);
  });

  it('codex reads cwd from session_meta', () => {
    put(
      join(home, '.codex/sessions/2026/10/01/rollout-a.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/code/infra"}}\n',
      300,
    );
    expect(RECENT_READERS['codex']!(home)).toEqual([{ dir: '/code/infra', at: 300_000 }]);
  });

  it('reads only the newest 200 codex sessions', () => {
    for (let i = 0; i < 205; i++) {
      const d = String(i).padStart(3, '0');
      put(join(home, `.codex/sessions/2026/10/01/rollout-${d}.jsonl`), `{"cwd":"/r/${d}"}\n`, 10);
    }
    const dirs = RECENT_READERS['codex']!(home).map((f) => f.dir);
    expect(dirs).toHaveLength(200);
    expect(dirs).not.toContain('/r/000');
  });

  it('cursor reads file:// folders and skips remote ones', () => {
    const user =
      process.platform === 'darwin'
        ? join(home, 'Library/Application Support/Cursor/User')
        : join(home, '.config/Cursor/User');
    put(join(user, 'workspaceStorage/a/workspace.json'), '{"folder":"file:///code/web"}');
    put(join(user, 'workspaceStorage/b/workspace.json'), '{"folder":"vscode-remote://ssh/x"}');
    expect(RECENT_READERS['cursor']!(home).map((f) => f.dir)).toEqual(['/code/web']);
  });

  it('grok reads trusted folders with decided_at', () => {
    put(
      join(home, '.grok/trusted_folders.toml'),
      '[folders."/code/api"]\ntrusted = true\ndecided_at = 500\n\n' +
        '[folders."/code/no"]\ntrusted = false\ndecided_at = 600\n',
    );
    expect(RECENT_READERS['grok']!(home)).toEqual([{ dir: '/code/api', at: 500_000 }]);
  });

  it('opencode reads worktree and skips /', () => {
    put(join(home, '.local/share/opencode/storage/project/a.json'), '{"worktree":"/code/cli"}', 50);
    put(join(home, '.local/share/opencode/storage/project/g.json'), '{"worktree":"/"}', 50);
    expect(RECENT_READERS['opencode']!(home)).toEqual([{ dir: '/code/cli', at: 50_000 }]);
  });

  it('a corrupt file yields [] rather than throwing', () => {
    put(join(home, '.local/share/opencode/storage/project/a.json'), '{not json');
    put(join(home, '.grok/trusted_folders.toml'), '\u0000\u0000');
    expect(RECENT_READERS['opencode']!(home)).toEqual([]);
    expect(RECENT_READERS['grok']!(home)).toEqual([]);
  });
});

describe('recentRepos', () => {
  const repo = (n: string) => {
    const d = join(home, 'code', n);
    mkdirSync(d, { recursive: true });
    return d;
  };

  it('merges one repo seen by several harnesses, newest first, capped', () => {
    const api = repo('api');
    const web = repo('web');
    put(join(home, '.grok/trusted_folders.toml'), `[folders."${api}"]\ntrusted = true\ndecided_at = 100\n`);
    put(join(home, '.local/share/opencode/storage/project/a.json'), JSON.stringify({ worktree: api }), 300);
    put(join(home, '.local/share/opencode/storage/project/b.json'), JSON.stringify({ worktree: web }), 200);
    const got = recentRepos({ ...base, home, harnessIds: ['grok', 'opencode'] });
    expect(got).toEqual([
      { dir: api, harnesses: ['grok', 'opencode'], lastUsed: 300_000 },
      { dir: web, harnesses: ['opencode'], lastUsed: 200_000 },
    ]);
    expect(recentRepos({ ...base, home, harnessIds: ['grok', 'opencode'], limit: 1 })).toHaveLength(1);
  });

  it('maps a subfolder to its git root', () => {
    const api = repo('api');
    const sub = join(api, 'packages/x');
    mkdirSync(sub, { recursive: true });
    put(join(home, '.local/share/opencode/storage/project/a.json'), JSON.stringify({ worktree: sub }), 1);
    const got = recentRepos({ ...base, home, harnessIds: ['opencode'], gitRoot: () => api });
    expect(got.map((r) => r.dir)).toEqual([api]);
  });

  it('keeps a non-git folder as itself', () => {
    const notes = repo('notes');
    put(join(home, '.local/share/opencode/storage/project/a.json'), JSON.stringify({ worktree: notes }), 1);
    const got = recentRepos({ ...base, home, harnessIds: ['opencode'], gitRoot: () => null });
    expect(got.map((r) => r.dir)).toEqual([notes]);
  });

  it('drops missing, temp, bound, refused and excluded folders', () => {
    const keep = repo('keep');
    const bound = repo('bound');
    const refused = repo('refused');
    const here = repo('here');
    const tmp = repo('tmp-scratch');
    const rows = [keep, bound, refused, here, tmp, join(home, 'gone')];
    rows.forEach((w, i) =>
      put(join(home, `.local/share/opencode/storage/project/${i}.json`), JSON.stringify({ worktree: w }), 1),
    );
    const got = recentRepos({
      ...base,
      home,
      harnessIds: ['opencode'],
      isBound: (d) => d === bound,
      isRefused: (d) => d === refused,
      exclude: [here],
      tmpRoots: [tmp],
    });
    expect(got.map((r) => r.dir)).toEqual([keep]);
  });

  it('ignores harness ids with no reader', () => {
    expect(recentRepos({ ...base, home, harnessIds: ['musterd', 'nope'] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/recents.test.ts`
Expected: FAIL — `Cannot find module './recents.js'`.

- [ ] **Step 3: Implement `recents.ts`**

```ts
import { execFileSync } from 'node:child_process';
import { existsSync, openSync, readdirSync, readFileSync, readSync, closeSync, realpathSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBinding } from '../config.js';
import { bindingRefusal } from './guard.js';

/**
 * Repo suggestions for `musterd init`'s connect path (lane 01M4FDBVGB): the folders each harness has
 * already recorded working in, read from its own plain files. Read-only and never throws — a harness
 * whose file is missing or unreadable contributes nothing. Formats checked on a real machine on
 * 2026-10-11 (opencode's from its source layout only; it was not installed there).
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
const CODEX_SESSION_CAP = 200;

function safe(fn: () => FolderSeen[]): FolderSeen[] {
  try {
    return fn();
  } catch {
    return [];
  }
}

function head(path: string, bytes: number): string {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.alloc(bytes);
    const n = readSync(fd, buf, 0, bytes, 0);
    return buf.subarray(0, n).toString('utf8');
  } finally {
    closeSync(fd);
  }
}

function cwdIn(path: string, bytes: number): string | null {
  const m = CWD_RE.exec(head(path, bytes));
  return m ? (JSON.parse(m[1]!) as string) : null;
}

function ls(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function claudeCode(home: string): FolderSeen[] {
  const root = join(home, '.claude', 'projects');
  const out: FolderSeen[] = [];
  for (const project of ls(root)) {
    const files = ls(join(root, project))
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => join(root, project, f))
      .map((p) => ({ p, at: statSync(p).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    const newest = files[0];
    if (!newest) continue;
    const dir = safeCwd(newest.p, 64 * 1024);
    if (dir) out.push({ dir, at: Math.round(newest.at) });
  }
  return out;
}

function safeCwd(path: string, bytes: number): string | null {
  try {
    return cwdIn(path, bytes);
  } catch {
    return null;
  }
}

function codex(home: string): FolderSeen[] {
  const root = join(home, '.codex', 'sessions');
  const files: string[] = [];
  const desc = (d: string) => ls(d).sort().reverse();
  outer: for (const y of desc(root))
    for (const m of desc(join(root, y)))
      for (const d of desc(join(root, y, m)))
        for (const f of desc(join(root, y, m, d))) {
          if (!f.endsWith('.jsonl')) continue;
          files.push(join(root, y, m, d, f));
          if (files.length >= CODEX_SESSION_CAP) break outer;
        }
  const out: FolderSeen[] = [];
  for (const p of files) {
    const dir = safeCwd(p, 4 * 1024);
    if (dir) out.push({ dir, at: Math.round(statSync(p).mtimeMs) });
  }
  return out;
}

function cursorUserDir(home: string): string {
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'Cursor', 'User');
  if (process.platform === 'win32')
    return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'Cursor', 'User');
  return join(home, '.config', 'Cursor', 'User');
}

function cursor(home: string): FolderSeen[] {
  const root = join(cursorUserDir(home), 'workspaceStorage');
  const out: FolderSeen[] = [];
  for (const id of ls(root)) {
    const path = join(root, id, 'workspace.json');
    if (!existsSync(path)) continue;
    try {
      const folder = (JSON.parse(readFileSync(path, 'utf8')) as { folder?: unknown }).folder;
      if (typeof folder !== 'string' || !folder.startsWith('file://')) continue;
      out.push({ dir: fileURLToPath(folder), at: Math.round(statSync(join(root, id)).mtimeMs) });
    } catch {
      // one unreadable workspace never hides the rest
    }
  }
  return out;
}

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

function opencode(home: string): FolderSeen[] {
  const root = join(home, '.local', 'share', 'opencode', 'storage', 'project');
  const out: FolderSeen[] = [];
  for (const f of ls(root)) {
    if (!f.endsWith('.json')) continue;
    const path = join(root, f);
    try {
      const wt = (JSON.parse(readFileSync(path, 'utf8')) as { worktree?: unknown }).worktree;
      if (typeof wt === 'string' && wt !== '/' && wt !== '')
        out.push({ dir: wt, at: Math.round(statSync(path).mtimeMs) });
    } catch {
      // skip a corrupt project file
    }
  }
  return out;
}

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
  limit?: number;
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
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: dir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

const under = (dir: string, root: string) => dir === root || dir.startsWith(root + sep);

export function recentRepos(opts: RecentReposOptions): RecentRepo[] {
  const gitRoot = opts.gitRoot ?? defaultGitRoot;
  const isBound = opts.isBound ?? ((d: string) => loadBinding(d).kind !== 'missing');
  const isRefused = opts.isRefused ?? ((d: string) => bindingRefusal(d, opts.home) !== null);
  const tmpRoots = (opts.tmpRoots ?? [tmpdir(), '/tmp', '/private/tmp', '/var/folders']).map(real);
  const exclude = new Set((opts.exclude ?? []).map(real));
  const byDir = new Map<string, RecentRepo>();
  const rootOf = new Map<string, string | null>();

  for (const id of opts.harnessIds) {
    const reader = RECENT_READERS[id];
    if (!reader) continue;
    for (const seen of reader(opts.home)) {
      if (!existsSync(seen.dir)) continue;
      const here = real(seen.dir);
      if (tmpRoots.some((t) => under(here, t))) continue;
      if (!rootOf.has(here)) rootOf.set(here, gitRoot(here));
      const dir = real(rootOf.get(here) ?? here);
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
```

Note: the fixture tests compare against paths under `mkdtemp`, which on macOS sit under
`/var/folders` — so tests pass `tmpRoots: []` (already in `base`), and the expected `dir`s are passed
through `realpathSync` if a test fails on `/private/var` vs `/var`; fix by wrapping the expected
values with `realpathSync` in the `recentRepos` tests.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/recents.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/recents.ts packages/cli/src/onboard/recents.test.ts
git commit -m "feat(cli): repo suggestions from what each harness recorded (lane 01M4FDBVGB)"
```
(with the seat and session trailers.)

---

### Task 2: Connect core

**Files:**
- Create: `packages/cli/src/onboard/connect.ts`
- Test: `packages/cli/src/onboard/connect.test.ts`

**Interfaces:**
- Consumes: `provisionAgentSeat(input: AgentSeatInput): Promise<AgentSeatResult>` from
  `./agentSeat.js`; `upsertPrimer(dir, block)`, `renderRepositoryPrimer({ team })` from `./primer.js`.
- Produces:
  ```ts
  export function seatNameFor(dir: string, taken: Iterable<string>): string;
  export interface ConnectResult {
    dir: string;
    name: string;
    status: 'ok' | 'partial' | 'failed';
    wired: string[];      // harness ids applied/unchanged/satisfied-unmanaged
    detail: string | null;
  }
  export interface ConnectReposInput {
    repos: string[];
    desired: string[];
    team: string;
    server: string;
    http: AgentSeatInput['http'];
    roster: string[];            // names already on the team
    rosterHome?: string;
    driver?: string;
    model?: string;
    provision?: typeof provisionAgentSeat;   // test seam
    writePrimer?: (dir: string) => void;     // test seam; default upsertPrimer(dir, renderRepositoryPrimer({ team }))
  }
  export async function connectRepos(input: ConnectReposInput): Promise<ConnectResult[]>;
  export function resultLine(r: ConnectResult, labels: Record<string, string>): string;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { connectRepos, resultLine, seatNameFor } from './connect.js';

const http = {} as never;
const okSeat = (dir: string) => ({
  workspace: { dir, kind: 'here' as const, created: false },
  reused: false,
  granted: true,
  wiring: {
    ok: true,
    results: [
      { harness: 'claude-code', result: 'applied' },
      { harness: 'cursor', result: 'unchanged' },
    ],
  },
  wiringError: null,
  seatFileUnpublished: null,
});

describe('seatNameFor', () => {
  it('uses the folder name, cleaned', () => {
    expect(seatNameFor('/code/My Repo', [])).toBe('my-repo');
    expect(seatNameFor('/code/.', [])).toBe('code');
    expect(seatNameFor('/', [])).toBe('agent');
  });
  it('suffixes a taken name, case-insensitively', () => {
    expect(seatNameFor('/code/web', ['Web'])).toBe('web-2');
    expect(seatNameFor('/code/web', ['web', 'web-2'])).toBe('web-3');
  });
});

describe('connectRepos', () => {
  const base = { desired: ['claude-code', 'cursor'], team: 'revive', server: 'http://x', http, roster: [] };

  it('gives three repos three seats bound in place with the same desired set', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) => okSeat(i.sourceDir));
    const writePrimer = vi.fn();
    const got = await connectRepos({ ...base, repos: ['/c/api', '/c/web', '/c/infra'], provision, writePrimer });
    expect(got.map((r) => [r.name, r.status])).toEqual([['api', 'ok'], ['web', 'ok'], ['infra', 'ok']]);
    for (const call of provision.mock.calls) {
      expect(call[0]).toMatchObject({ here: true, harnesses: ['claude-code', 'cursor'], toolkit: '', team: 'revive' });
    }
    expect(writePrimer).toHaveBeenCalledTimes(3);
    expect(got[0]!.wired).toEqual(['claude-code', 'cursor']);
  });

  it('names two same-named repos web and web-2', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) => okSeat(i.sourceDir));
    const got = await connectRepos({ ...base, repos: ['/a/web', '/b/web'], provision, writePrimer: () => {} });
    expect(got.map((r) => r.name)).toEqual(['web', 'web-2']);
  });

  it('a failing repo leaves the others connected', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) => {
      if (i.sourceDir === '/c/web') throw new Error('mint refused');
      return okSeat(i.sourceDir);
    });
    const writePrimer = vi.fn();
    const got = await connectRepos({ ...base, repos: ['/c/api', '/c/web', '/c/infra'], provision, writePrimer });
    expect(got.map((r) => r.status)).toEqual(['ok', 'failed', 'ok']);
    expect(got[1]!.detail).toBe('mint refused');
    expect(writePrimer).toHaveBeenCalledTimes(2);
  });

  it('partial wiring keeps the seat and says which harness', async () => {
    const provision = vi.fn(async (i: { sourceDir: string }) => ({
      ...okSeat(i.sourceDir),
      wiring: {
        ok: false,
        results: [
          { harness: 'claude-code', result: 'applied' },
          { harness: 'cursor', result: 'conflict', detail: 'mcp.json unreadable' },
        ],
      },
    }));
    const [r] = await connectRepos({ ...base, repos: ['/c/web'], provision, writePrimer: () => {} });
    expect(r).toMatchObject({ status: 'partial', wired: ['claude-code'], detail: 'cursor: mcp.json unreadable' });
  });

  it('appends the primer to an existing AGENTS.md', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'connect-'));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'AGENTS.md'), '# Mine\n');
    const provision = vi.fn(async (i: { sourceDir: string }) => okSeat(i.sourceDir));
    await connectRepos({ ...base, repos: [dir], provision });
    const body = readFileSync(join(dir, 'AGENTS.md'), 'utf8');
    expect(body.startsWith('# Mine\n')).toBe(true);
    expect(body).toContain('musterd');
  });
});

describe('resultLine', () => {
  const labels = { 'claude-code': 'Claude Code', cursor: 'Cursor' };
  it('renders ok, partial and failed', () => {
    expect(resultLine({ dir: '/c/web', name: 'web', status: 'ok', wired: ['claude-code', 'cursor'], detail: null }, labels))
      .toContain('web — Claude Code, Cursor');
    expect(resultLine({ dir: '/c/web', name: 'web', status: 'partial', wired: ['claude-code'], detail: 'cursor: x' }, labels))
      .toContain('run musterd wire there');
    expect(resultLine({ dir: '/c/web', name: 'web', status: 'failed', wired: [], detail: 'boom' }, labels))
      .toContain('web — boom');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/connect.test.ts`
Expected: FAIL — `Cannot find module './connect.js'`.

- [ ] **Step 3: Implement the core of `connect.ts`**

```ts
import { basename, resolve } from 'node:path';
import { paint as pc } from '../render/theme.js';
import { sym } from '../render/ui.js';
import { provisionAgentSeat, type AgentSeatInput } from './agentSeat.js';
import { renderRepositoryPrimer, upsertPrimer } from './primer.js';

/**
 * `musterd init`'s default path (lane 01M4FDBVGB, ADR <n>): one seat per picked repo, every chosen
 * harness wired into each, in one run. The per-repo work is `provisionAgentSeat` with `here: true` —
 * the same sequence as `musterd agent --here` — so nothing here re-implements minting or wiring.
 */
export function seatNameFor(dir: string, taken: Iterable<string>): string {
  const raw = basename(resolve(dir));
  const clean =
    raw
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'agent';
  const lower = new Set([...taken].map((n) => n.toLowerCase()));
  if (!lower.has(clean)) return clean;
  for (let i = 2; ; i++) if (!lower.has(`${clean}-${i}`)) return `${clean}-${i}`;
}

export interface ConnectResult {
  dir: string;
  name: string;
  status: 'ok' | 'partial' | 'failed';
  wired: string[];
  detail: string | null;
}

export interface ConnectReposInput {
  repos: string[];
  desired: string[];
  team: string;
  server: string;
  http: AgentSeatInput['http'];
  roster: string[];
  rosterHome?: string | undefined;
  driver?: string | undefined;
  model?: string | undefined;
  provision?: typeof provisionAgentSeat;
  writePrimer?: (dir: string) => void;
}

const WIRED = new Set(['applied', 'unchanged', 'satisfied-unmanaged']);

export async function connectRepos(input: ConnectReposInput): Promise<ConnectResult[]> {
  const provision = input.provision ?? provisionAgentSeat;
  const writePrimer =
    input.writePrimer ?? ((dir: string) => void upsertPrimer(dir, renderRepositoryPrimer({ team: input.team })));
  const taken = [...input.roster];
  const out: ConnectResult[] = [];
  for (const dir of input.repos) {
    const name = seatNameFor(dir, taken);
    taken.push(name);
    try {
      const r = await provision({
        name,
        team: input.team,
        server: input.server,
        http: input.http,
        harnesses: input.desired,
        toolkit: '',
        sourceDir: dir,
        here: true,
        rosterHome: input.rosterHome,
        driver: input.driver,
        model: input.model,
      });
      const results = r.wiring?.results ?? [];
      const wired = results.filter((x) => WIRED.has(x.result)).map((x) => x.harness);
      const bad = results.filter((x) => !WIRED.has(x.result) && x.result !== 'pending');
      const detail =
        r.wiringError ?? (bad.length ? bad.map((x) => `${x.harness}: ${x.detail ?? x.result}`).join('; ') : null);
      writePrimer(dir);
      out.push({ dir, name, status: detail ? 'partial' : 'ok', wired, detail });
    } catch (err) {
      out.push({ dir, name, status: 'failed', wired: [], detail: (err as Error).message });
    }
  }
  return out;
}

export function resultLine(r: ConnectResult, labels: Record<string, string>): string {
  const harnesses = r.wired.map((id) => labels[id] ?? id).join(', ') || 'no harness wired';
  if (r.status === 'failed') return `${pc.red(sym.cross)} ${r.name} — ${r.detail}`;
  if (r.status === 'partial')
    return `${pc.yellow('⚠')} ${r.name} — ${harnesses}; ${r.detail}; run musterd wire there`;
  return `${pc.green(sym.check)} ${r.name} — ${harnesses}`;
}
```

Before writing, confirm `sym.cross` / `sym.check` exist in `packages/cli/src/render/ui.ts`
(`grep -n "check\|cross" packages/cli/src/render/ui.ts`) and use the names it exports; confirm the
`ReconcileReport.results[]` field names (`harness`, `result`, `detail`) in
`packages/cli/src/onboard/reconcile/engine.ts` — `init.ts:866-875` already reads exactly these.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/connect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/onboard/connect.ts packages/cli/src/onboard/connect.test.ts
git commit -m "feat(cli): connect core — one seat per repo, every harness wired (lane 01M4FDBVGB)"
```

---

### Task 3: The prompts and the init menu

**Files:**
- Modify: `packages/cli/src/onboard/connect.ts` (add `runConnect`)
- Modify: `packages/cli/src/onboard/init.ts:577-596` (menu option + hand-off)
- Test: `packages/cli/src/onboard/connect.test.ts` (prompt layer), `packages/cli/src/onboard/init.test.ts`
  (hand-off)

**Interfaces:**
- Consumes: Task 1 `recentRepos`, Task 2 `connectRepos`/`resultLine`; `HARNESSES`,
  `harnessAdapters()` from `./harnesses/index.js`; `bindingRefusal` from `./guard.js`;
  `HttpClient.roster(team)`.
- Produces:
  ```ts
  export interface RunConnectInput {
    team: string;
    server: string;
    http: HttpClient;
    cwd: string;
    home: string;
    rosterHome?: string;
    driver?: string;
    model?: string;
  }
  export async function runConnect(input: RunConnectInput): Promise<number>; // 0 ok, 1 any failure
  ```

- [ ] **Step 1: Write the failing tests**

In `connect.test.ts`, mock `@clack/prompts` the way `init.test.ts` does (hoisted queues), plus
`./harnesses/index.js` and `./recents.js`:

```ts
const q = vi.hoisted(() => ({ multi: [] as unknown[], select: [] as unknown[] }));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(), outro: vi.fn(), note: vi.fn(), isCancel: () => false, cancel: vi.fn(),
  log: { info: vi.fn(), step: vi.fn(), warn: vi.fn(), success: vi.fn(), message: vi.fn() },
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  multiselect: vi.fn(async () => q.multi.shift()),
}));
vi.mock('./harnesses/index.js', () => ({
  HARNESSES: [
    { id: 'claude-code', label: 'Claude Code', detect: async () => ({ installed: true, configured: false }) },
    { id: 'cursor', label: 'Cursor', detect: async () => ({ installed: true, configured: false }) },
    { id: 'codex', label: 'Codex', detect: async () => ({ installed: false, configured: false }) },
  ],
  harnessAdapters: () => [{ id: 'claude-code' }, { id: 'cursor' }, { id: 'codex' }, { id: 'musterd' }],
}));
const recents = vi.hoisted(() => ({ rows: [] as { dir: string; harnesses: string[]; lastUsed: number }[] }));
vi.mock('./recents.js', () => ({ recentRepos: () => recents.rows }));
const prov = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('./agentSeat.js', () => ({ provisionAgentSeat: prov.fn }));
```

```ts
describe('runConnect', () => {
  const http = { roster: vi.fn(async () => ({ members: [{ name: 'nick' }] })) } as never;
  const input = (cwd: string) => ({ team: 'revive', server: 'http://x', http, cwd, home: '/home/x' });

  beforeEach(() => {
    prov.fn.mockReset();
    prov.fn.mockImplementation(async (i: { sourceDir: string }) => okSeat(i.sourceDir));
  });

  it('offers this folder first and connects what is picked with installed harnesses', async () => {
    const here = mkdtempSync(join(tmpdir(), 'here-'));
    recents.rows = [{ dir: '/c/web', harnesses: ['cursor'], lastUsed: Date.now() }];
    q.multi.push(['claude-code', 'cursor'], [here, '/c/web']);
    const { multiselect } = await import('@clack/prompts');
    expect(await runConnect(input(here))).toBe(0);
    const repoPrompt = vi.mocked(multiselect).mock.calls[1]![0] as { options: { value: string }[]; initialValues: string[] };
    expect(repoPrompt.options.map((o) => o.value)).toEqual([here, '/c/web']);
    expect(repoPrompt.initialValues).toEqual([here]);
    expect(prov.fn.mock.calls.map((c) => c[0].harnesses)).toEqual([['claude-code', 'cursor'], ['claude-code', 'cursor']]);
  });

  it('refused cwd is not offered', async () => {
    recents.rows = [{ dir: '/c/web', harnesses: ['cursor'], lastUsed: 1 }];
    q.multi.push(['claude-code'], ['/c/web']);
    const { multiselect } = await import('@clack/prompts');
    vi.mocked(multiselect).mockClear();
    expect(await runConnect({ ...input(homedir()), home: homedir() })).toBe(0);
    const repoPrompt = vi.mocked(multiselect).mock.calls[1]![0] as { options: { value: string }[] };
    expect(repoPrompt.options.map((o) => o.value)).toEqual(['/c/web']);
  });

  it('no repos picked connects nothing', async () => {
    recents.rows = [];
    q.multi.push(['claude-code'], []);
    expect(await runConnect(input(mkdtempSync(join(tmpdir(), 'h-'))))).toBe(0);
    expect(prov.fn).not.toHaveBeenCalled();
  });

  it('exits 1 when any repo failed', async () => {
    const here = mkdtempSync(join(tmpdir(), 'here-'));
    recents.rows = [];
    prov.fn.mockRejectedValueOnce(new Error('mint refused'));
    q.multi.push(['claude-code'], [here]);
    expect(await runConnect(input(here))).toBe(1);
  });
});
```

(`homedir` from `node:os`; `runConnect` added to the `./connect.js` import.)

In `init.test.ts`, add one case next to the existing "Add a new agent" cases (`:688`), using the
file's existing hoisted queues and a `vi.mock('./connect.js', …)` that records the call:

```ts
it('"Connect the agents you already have" hands off to runConnect', async () => {
  // queue answers exactly as the neighbouring cases do up to the intent select, then:
  h.selectQueue.push('connect');
  connectMock.mockResolvedValueOnce(0);
  expect(await runInit()).toBe(0);
  expect(connectMock).toHaveBeenCalledWith(expect.objectContaining({ team: expect.any(String) }));
  expect(h.http.addMember).not.toHaveBeenCalled();
});
```

Copy the preceding queue pushes (team step answers) from the nearest existing `runInit` case
verbatim; read `init.test.ts:680-760` before writing it.

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/connect.test.ts src/onboard/init.test.ts`
Expected: FAIL — `runConnect` not exported; init has no `connect` option.

- [ ] **Step 3: Implement `runConnect`**

Append to `connect.ts` (add imports `* as p from '@clack/prompts'`, `realpathSync` from `node:fs`,
`HttpClient` type from `../client.js`, `HARNESSES, harnessAdapters` from `./harnesses/index.js`,
`bindingRefusal` from `./guard.js`, `recentRepos` from `./recents.js`). `init.ts` imports
`connect.ts`, so `connect.ts` must not import `init.ts`: copy init's 8-line `guard` (`init.ts:375`)
into `connect.ts` as a private function. Leave `init.ts`'s `guard` unexported.

```ts
export interface RunConnectInput {
  team: string;
  server: string;
  http: HttpClient;
  cwd: string;
  home: string;
  rosterHome?: string | undefined;
  driver?: string | undefined;
  model?: string | undefined;
}

function ago(ms: number, now: number): string {
  const m = Math.max(0, Math.round((now - ms) / 60_000));
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

const tilde = (dir: string, home: string) => (dir.startsWith(home + '/') ? '~' + dir.slice(home.length) : dir);

export async function runConnect(input: RunConnectInput): Promise<number> {
  const sd = p.spinner();
  sd.start('Looking for the agents on this machine');
  const detected = await Promise.all(HARNESSES.map(async (h) => ({ h, d: await h.detect() })));
  sd.stop('Scanned for agents');
  for (const { h, d } of detected)
    p.log.step(`${pc.bold(h.label)} ${pc.dim('—')} ${d.installed ? pc.yellow('installed') : pc.dim('not installed')}`);

  const labels = Object.fromEntries(HARNESSES.map((h) => [h.id, h.label]));
  const installed = new Set(detected.filter((x) => x.d.installed).map((x) => x.h.id));
  const adapters = harnessAdapters().filter((a) => a.id !== 'musterd');
  const desired = guard(
    await p.multiselect({
      message: 'Which agents should join? (space toggles, enter confirms)',
      options: adapters.map((a) => ({
        value: a.id,
        label: labels[a.id] ?? a.id,
        ...(installed.has(a.id) ? {} : { hint: 'pending — not installed here' }),
      })),
      initialValues: adapters.filter((a) => installed.has(a.id)).map((a) => a.id),
      required: false,
    }),
  ) as string[];

  const now = Date.now();
  const here = realpathSync(input.cwd);
  const hereOk = bindingRefusal(here, input.home) === null;
  const suggestions = recentRepos({ home: input.home, harnessIds: [...installed], exclude: [here] });
  const options = [
    ...(hereOk ? [{ value: here, label: tilde(here, input.home), hint: 'this folder' }] : []),
    ...suggestions.map((r) => ({
      value: r.dir,
      label: tilde(r.dir, input.home),
      hint: `${r.harnesses.map((id) => labels[id] ?? id).join(', ')} · ${ago(r.lastUsed, now)}`,
    })),
  ];
  const repos = guard(
    await p.multiselect({
      message: 'Which repos should be connected? (each becomes a seat)',
      options,
      initialValues: hereOk ? [here] : [],
      required: false,
    }),
  ) as string[];
  if (repos.length === 0) {
    p.outro('Nothing connected. Run `musterd init` again when you want to.');
    return 0;
  }

  const { members } = await input.http.roster(input.team);
  const s = p.spinner();
  s.start(`Connecting ${repos.length} repo${repos.length === 1 ? '' : 's'}`);
  const results = await connectRepos({
    repos,
    desired,
    team: input.team,
    server: input.server,
    http: input.http,
    roster: members.map((m) => m.name),
    rosterHome: input.rosterHome,
    driver: input.driver,
    model: input.model,
  });
  s.stop('Done');
  for (const r of results) p.log.message(resultLine(r, labels));

  const started = results.filter((r) => r.status !== 'failed');
  if (started.length > 0) {
    const LAUNCH: Record<string, (d: string) => string> = {
      'claude-code': (d) => `cd ${d} && claude`,
      codex: (d) => `cd ${d} && codex`,
      opencode: (d) => `cd ${d} && opencode`,
      grok: (d) => `cd ${d} && grok`,
      cursor: (d) => `open ${d} in Cursor`,
    };
    const launch = LAUNCH[desired[0] ?? ''] ?? ((d: string) => `cd ${d} && musterd run`);
    p.note(
      started.map((r) => `${pc.cyan(r.name)}  ${launch(tilde(r.dir, input.home))}`).join('\n') +
        `\n\n${pc.yellow('musterd status')}   see them on the roster`,
      'Start any of them',
    );
  }
  p.outro(pc.yellow(`${started.length} seat${started.length === 1 ? '' : 's'} on ${input.team}.`));
  return results.some((r) => r.status === 'failed') ? 1 : 0;
}
```

Check the native-host launch command (`musterd run` above) against `activationFor` in
`init.ts:960+` and use the same string it uses for `musterd`.

- [ ] **Step 4: Hook it into `init.ts`**

At the intent select (`init.ts:579`), add the option first:

```ts
options: [
  {
    value: 'connect',
    label: 'Connect the agents you already have',
    hint: 'one seat per repo, every agent on this machine wired in',
  },
  { value: 'new', label: 'Add a new agent', hint: 'connect a coding agent as a teammate' },
  // …existing options unchanged
],
initialValue: 'connect',
```

and immediately after the select, before `if (intent === 'watch')`:

```ts
if (intent === 'connect') {
  return runConnect({
    team,
    server,
    http,
    cwd: process.cwd(),
    home: homedir(),
    rosterHome: config.rosterHome[team],
    driver: config.current ? config.identities[config.current]?.name?.trim() : undefined,
    model: resolveAttestedModel(process.env),
  });
}
```

Import `runConnect` from `./connect.js` and `homedir` from `node:os`. Note the early
`bindingRefusal(process.cwd())` at `init.ts:415` still hard-refuses before any prompt; that stays —
the refused-cwd case in `runConnect` covers a cwd that passes it but should not be offered (none
today; the test documents the contract).

- [ ] **Step 5: Run to verify they pass**

Run: `pnpm --filter @musterd/cli exec vitest run src/onboard/connect.test.ts src/onboard/init.test.ts`
Expected: PASS, including every pre-existing init case (the default changed, but each existing case
pushes its intent explicitly — if one relied on the old default, push `'new'` for it).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/onboard/connect.ts packages/cli/src/onboard/connect.test.ts \
  packages/cli/src/onboard/init.ts packages/cli/src/onboard/init.test.ts
git commit -m "feat(cli): init's default is connect the agents you already have (lane 01M4FDBVGB)"
```

---

### Task 4: ADR, docs, frames, ship

**Files:**
- Create: `docs/decisions/<NNN>-init-connects-what-you-have.md`
- Modify: `docs/architecture/04-cli.md` (init flow; file-tree lines for `recents.ts`, `connect.ts`)
- Modify: `docs/design/figma-brief-terminal.md` (three screens)

- [ ] **Step 1: Take the ADR number and publish it**

```bash
pnpm adr:next
git push -u origin docs/first-run-connect
gh pr create --draft --title "feat(cli): first run connects the agents you already have (lane 01M4FDBVGB)" \
  --body "Lane \`01M4FDBVGB\`. Draft — ADR <NNN> reserved."
```

- [ ] **Step 2: Write the ADR** (Context / Problem / Decision / Consequences, per
  `07-conventions.md`): init's default intent connects every installed harness into each picked
  repo, one seat per repo; suggestions come from harness-recorded folders, read-only; rejected
  alternatives (seat per harness, one run per repo, a separate `musterd connect`). Consequences: the
  roster grows by one seat per repo; `musterd agent` stays the detailed path; opencode's record
  location is unverified on a live install (`Follows-up:` a check on the first machine with opencode).

- [ ] **Step 3: Update `04-cli.md`** — the init section gains the connect path in order (harnesses,
  repos, per-repo provision, summary); the onboard file tree gains:
  ```
  recents.ts        repo suggestions from the folders each harness recorded (read-only)
  connect.ts        init's connect path: one seat per picked repo, every chosen harness wired
  ```

- [ ] **Step 4: Add the three screens to `figma-brief-terminal.md`** — the intent menu with the new
  first option, the repo picker (this folder + suggestions with `harnesses · age` hints), and the
  summary (`✓`/`⚠`/`✗` lines + "Start any of them" note). Copy the exact strings from
  `connect.ts` / `init.ts`.

- [ ] **Step 5: Fast gates**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: all exit 0 (if `typecheck` refuses on stale dist, run `npx tsc --noEmit` in
`packages/cli`).

- [ ] **Step 6: Commit, mark ready, auto-merge**

```bash
git add docs/ packages/
git commit -m "docs: ADR <NNN>, CLI doc and terminal frames for init's connect path (lane 01M4FDBVGB)

Refs ADR-<NNN>"
git push
gh pr ready <n> && gh pr merge <n> --squash --auto --delete-branch
```

- [ ] **Step 7: After merge** — `lane_submit {pr, sha}`, follow its reply; message alfie that
  `runConnect` has its own ending so the tour offer goes after its summary too; clear the local
  branch (`git switch --detach origin/main && git branch -D docs/first-run-connect`).
