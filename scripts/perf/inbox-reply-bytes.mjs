#!/usr/bin/env node
/**
 * `team_inbox_check` reply size before and after #2517 (lane 01M562HNQF47JM32EAVVHZMTAA).
 *
 *   node scripts/perf/inbox-reply-bytes.mjs <repo> <db> <team> <seat> <label>=<ref> [<label>=<ref> ...]
 *
 * Replays the last N acts a seat could see (team-wide and addressed to it) from <db> through each
 * ref's own `registerInboxCheck` handler, behind a fake client that serves them as the unread tail,
 * and prints the characters of the text form and of the structured form: Claude Code hands the model
 * the structured one, which is why #2517 budgets the larger of the two. Real bodies and meta stay in
 * memory; only sizes are printed. Refs are built in worktrees; N = 20, 50 and a 200-act backlog.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [repo, dbPath, teamSlug, seat, ...rest] = process.argv.slice(2);
const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

if (process.env.INBOX_CHILD) {
  const Database = createRequire(join(repo, 'packages/server/package.json'))('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const team = db.prepare('SELECT id FROM teams WHERE slug = ?').get(teamSlug).id;
  const me = db.prepare('SELECT id FROM members WHERE team_id = ? AND name = ?').get(team, seat).id;
  const names = new Map(
    db
      .prepare('SELECT id, name FROM members WHERE team_id = ?')
      .all(team)
      .map((m) => [m.id, m.name]),
  );
  const rows = db
    .prepare(
      `SELECT * FROM messages WHERE team_id = ? AND (to_kind != 'member' OR to_member = ?) AND act != 'insight'
       ORDER BY ts DESC LIMIT 200`,
    )
    .all(team, me)
    .reverse();
  const envs = rows.map((r) => ({
    id: r.id,
    from: names.get(r.from_member) ?? 'unknown',
    act: r.act,
    body: r.body,
    ts: r.ts,
    to:
      r.to_kind === 'member'
        ? { kind: 'member', name: names.get(r.to_member) }
        : { kind: r.to_kind },
    ...(r.thread_id ? { thread: r.thread_id } : {}),
    ...(r.meta ? { meta: JSON.parse(r.meta) } : {}),
  }));
  const { registerInboxCheck } = await import(join(process.env.INBOX_DIST, 'tools/inboxCheck.js'));
  const out = {};
  for (const n of [20, 50, 200]) {
    const slice = envs.slice(-n);
    const client = new Proxy(
      {
        holdsSeat: true,
        member: seat,
        workspaceDir: '/nonexistent',
        style: null,
        styleUnshown: null,
        drainBuffer: () => [],
        fetchInbox: async (_u, limit) => {
          const tail = limit ? slice.slice(-limit) : slice;
          return {
            messages: tail,
            unread_remaining: slice.length - tail.length,
            answered: [],
            discharged: [],
          };
        },
        laneBoard: async () => ({ lanes: [] }),
        markRead: async () => undefined,
      },
      { get: (t, k) => (k in t ? t[k] : async () => undefined) },
    );
    let handler;
    registerInboxCheck(
      {
        registerTool: (_n, _c, h) => {
          handler = h;
        },
      },
      client,
    );
    const r = await handler({ unread_only: true, limit: 50 });
    out[n] = {
      text: r.content.reduce((a, c) => a + (c.text?.length ?? 0), 0),
      structured: JSON.stringify(r.structuredContent ?? null).length,
    };
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-inbox-')));
const result = {};
for (const s of rest) {
  const [label, ref] = s.split('=');
  const dir = join(scratch, label);
  sh('git', ['worktree', 'add', '--detach', '--quiet', dir, ref], repo);
  sh(
    'pnpm',
    ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@musterd/mcp...'],
    dir,
  );
  sh('pnpm', ['--filter', '@musterd/mcp...', 'build'], dir);
  // The shipped dist is one bundle (#2435) with no importable tool modules, so compile the same
  // sources unbundled beside it.
  sh(
    'pnpm',
    ['exec', 'tsc', '-p', 'tsconfig.json', '--outDir', 'tsc-out'],
    join(dir, 'packages/mcp'),
  );
  const sha = sh('git', ['rev-parse', '--short', 'HEAD'], dir).trim();
  const line = execFileSync('node', [process.argv[1], repo, dbPath, teamSlug, seat], {
    encoding: 'utf8',
    env: { ...process.env, INBOX_CHILD: '1', INBOX_DIST: join(dir, 'packages/mcp/tsc-out') },
  })
    .trim()
    .split('\n')
    .at(-1);
  result[label] = { sha, ...JSON.parse(line) };
}
console.log(JSON.stringify(result, null, 2));
