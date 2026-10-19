import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
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
// The fixture home sits under the OS temp dir, so these tests turn the temp filter off and fake
// the git root; the filters get their own case below.
const base = {
  gitRoot: (d: string) => d,
  isBound: () => false,
  isRefused: () => false,
  tmpRoots: [] as string[],
};
const opencodeFile = (name: string) =>
  join(home, '.local/share/opencode/storage/project', `${name}.json`);

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'recents-')));
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
    expect(dirs).toContain('/r/204');
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
    put(opencodeFile('a'), '{"worktree":"/code/cli"}', 50);
    put(opencodeFile('g'), '{"worktree":"/"}', 50);
    expect(RECENT_READERS['opencode']!(home)).toEqual([{ dir: '/code/cli', at: 50_000 }]);
  });

  it('opencode reads project rows from opencode.db and skips /', () => {
    const db = join(home, '.local/share/opencode/opencode.db');
    mkdirSync(join(db, '..'), { recursive: true });
    execFileSync('sqlite3', [
      db,
      `CREATE TABLE project (
        id text PRIMARY KEY,
        worktree text NOT NULL,
        time_created integer NOT NULL,
        time_updated integer NOT NULL,
        sandboxes text NOT NULL,
        time_active integer DEFAULT 0 NOT NULL
      );
      INSERT INTO project VALUES
        ('p1', '/code/runtime', 1000, 2000, '[]', 7000),
        ('p2', '/code/legacy', 1000, 5000, '[]', 0),
        ('global', '/', 1000, 9000, '[]', 9000);`,
    ]);
    expect(RECENT_READERS['opencode']!(home)).toEqual([
      { dir: '/code/runtime', at: 7000 },
      { dir: '/code/legacy', at: 5000 },
    ]);
  });

  it('a corrupt or missing file yields [] rather than throwing', () => {
    put(opencodeFile('a'), '{not json');
    put(join(home, '.local/share/opencode/opencode.db'), 'not a sqlite db');
    put(join(home, '.grok/trusted_folders.toml'), '\u0000\u0000');
    expect(RECENT_READERS['opencode']!(home)).toEqual([]);
    expect(RECENT_READERS['grok']!(home)).toEqual([]);
    expect(RECENT_READERS['claude-code']!(home)).toEqual([]);
    expect(RECENT_READERS['codex']!(home)).toEqual([]);
    expect(RECENT_READERS['cursor']!(home)).toEqual([]);
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
    put(
      join(home, '.grok/trusted_folders.toml'),
      `[folders."${api}"]\ntrusted = true\ndecided_at = 100\n`,
    );
    put(opencodeFile('a'), JSON.stringify({ worktree: api }), 300);
    put(opencodeFile('b'), JSON.stringify({ worktree: web }), 200);
    const got = recentRepos({ ...base, home, harnessIds: ['grok', 'opencode'] });
    expect(got).toEqual([
      { dir: api, harnesses: ['grok', 'opencode'], lastUsed: 300_000 },
      { dir: web, harnesses: ['opencode'], lastUsed: 200_000 },
    ]);
    expect(recentRepos({ ...base, home, harnessIds: ['grok', 'opencode'], limit: 1 })).toHaveLength(
      1,
    );
  });

  it('maps a subfolder to its git root', () => {
    const api = repo('api');
    const sub = join(api, 'packages/x');
    mkdirSync(sub, { recursive: true });
    put(opencodeFile('a'), JSON.stringify({ worktree: sub }), 1);
    const got = recentRepos({ ...base, home, harnessIds: ['opencode'], gitRoot: () => api });
    expect(got.map((r) => r.dir)).toEqual([api]);
  });

  it('keeps a non-git folder as itself', () => {
    const notes = repo('notes');
    put(opencodeFile('a'), JSON.stringify({ worktree: notes }), 1);
    const got = recentRepos({ ...base, home, harnessIds: ['opencode'], gitRoot: () => null });
    expect(got.map((r) => r.dir)).toEqual([notes]);
  });

  it('drops missing, temp, bound, refused and excluded folders', () => {
    const keep = repo('keep');
    const bound = repo('bound');
    const refused = repo('refused');
    const here = repo('here');
    const tmp = repo('tmp-scratch');
    [keep, bound, refused, here, tmp, join(home, 'gone')].forEach((w, i) =>
      put(opencodeFile(String(i)), JSON.stringify({ worktree: w }), 1),
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
