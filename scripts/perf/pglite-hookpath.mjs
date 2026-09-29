// Q2 of the PGlite spike: the PreToolUse gate's own queries on better-sqlite3 vs PGlite, same seed,
// same SQL text. `scale: 1` is revive's order of magnitude on 2026-09-29 (50 members, 400 lanes,
// 18k messages, 230k audit rows).
//   node scripts/perf/pglite-hookpath.mjs [scale] [rounds]
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { PGlite } from '@electric-sql/pglite';
import { splitStatements, sqliteToPostgres } from './pglite-schema.mjs';

// better-sqlite3 is @musterd/server's dependency, not the root's; the spike borrows the server's copy
// rather than adding a second native module to the workspace root (hard rule 6).
const Database = createRequire(new URL('../../packages/server/package.json', import.meta.url))(
  'better-sqlite3',
);

const DDL = `
CREATE TABLE teams (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, policy_json TEXT NOT NULL);
CREATE TABLE members (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, name TEXT NOT NULL, kind TEXT NOT NULL, left_at INTEGER);
CREATE UNIQUE INDEX idx_members_team_name ON members(team_id, name);
CREATE TABLE lanes (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, title TEXT NOT NULL, state TEXT NOT NULL, owner_seat TEXT, scope_json TEXT NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX idx_lanes_team_state ON lanes(team_id, state);
CREATE TABLE messages (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, to_member TEXT, act TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX idx_messages_team_to_created ON messages(team_id, to_member, created_at);
CREATE TABLE audit (id TEXT PRIMARY KEY, team_id TEXT NOT NULL, verb TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX idx_audit_team_verb ON audit(team_id, verb, created_at);
`;

export const QUERY_NAMES = [
  'getPolicy',
  'laneCoveringPath',
  'getMemberByName',
  'unreadSince',
  'findGateAsk',
];

/** [sql (SQLite text — the PGlite driver rewrites it), params(seed)] */
const QUERIES = {
  getPolicy: ['SELECT policy_json FROM teams WHERE id = ?', (s) => [s.team]],
  laneCoveringPath: [
    "SELECT id, title, owner_seat, scope_json FROM lanes WHERE team_id = ? AND state IN ('claimed','active','blocked')",
    (s) => [s.team],
  ],
  getMemberByName: [
    'SELECT * FROM members WHERE team_id = ? AND name = ?',
    (s) => [s.team, 'seat-7'],
  ],
  unreadSince: [
    'SELECT count(*) AS n FROM messages WHERE team_id = ? AND to_member = ? AND created_at > ?',
    (s) => [s.team, 'seat-7', s.cursorTs],
  ],
  findGateAsk: [
    "SELECT id FROM audit WHERE team_id = ? AND verb = 'action.gate' AND json_extract(detail, '$.class') = ? ORDER BY created_at DESC LIMIT 1",
    (s) => [s.team, 'deploy'],
  ],
};

/** `?` → `$1..$n` outside single-quoted literals (Review Focus 4). */
export function toPgPlaceholders(sql) {
  let n = 0;
  return sql
    .split(/('(?:[^']|'')*')/)
    .map((part, i) => (i % 2 ? part : part.replace(/\?/g, () => `$${++n}`)))
    .join('');
}

function ulidish(i) {
  return String(i).padStart(26, '0');
}

function seedRows(scale) {
  return {
    team: 'team-1',
    members: Math.max(3, Math.round(50 * scale)),
    lanes: Math.max(3, Math.round(400 * scale)),
    messages: Math.max(10, Math.round(18_000 * scale)),
    audit: Math.max(10, Math.round(230_000 * scale)),
    cursorTs: Date.now() - 3_600_000,
  };
}

async function openBackend(backend, dir) {
  const t0 = performance.now();
  if (backend === 'sqlite') {
    const file = join(dir, 'bench.db');
    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    const run = async (sql, params) => {
      db.prepare(sql).run(...params);
    };
    return {
      exec: async (sql) => {
        db.exec(sql);
      },
      all: async (sql, params) => db.prepare(sql).all(...params),
      run,
      // better-sqlite3's db.transaction() cannot wrap an async body; BEGIN/COMMIT by hand keeps one
      // call shape across both engines (the same finding Task 5's driver records).
      tx: async (fn) => {
        db.exec('BEGIN');
        try {
          await fn({ run });
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
      },
      close: async () => db.close(),
      boot_ms: performance.now() - t0,
      file,
    };
  }
  const file = backend === 'pglite-file' ? join(dir, 'pgdata') : null;
  const pg = file ? new PGlite(file) : new PGlite();
  await pg.waitReady;
  const prep = (sql) => toPgPlaceholders(sqliteToPostgres(sql));
  const runOn = (q) => async (sql, params) => {
    await q.query(prep(sql), params);
  };
  return {
    exec: async (sql) => {
      await pg.exec(sql);
    },
    all: async (sql, params) => (await pg.query(prep(sql), params)).rows,
    run: runOn(pg),
    tx: async (fn) => pg.transaction((t) => fn({ run: runOn(t) })),
    close: async () => pg.close(),
    boot_ms: performance.now() - t0,
    file,
  };
}

async function seed(b, backend, s) {
  const ddl = backend === 'sqlite' ? DDL : sqliteToPostgres(DDL);
  for (const stmt of splitStatements(ddl)) await b.exec(stmt);
  await b.run('INSERT INTO teams VALUES (?, ?, ?)', [
    s.team,
    'revive',
    JSON.stringify({ enforcement: { classes: [{ class: 'deploy', posture: 'block' }] } }),
  ]);
  const now = Date.now();
  await b.tx(async (t) => {
    for (let i = 0; i < s.members; i++)
      await t.run('INSERT INTO members VALUES (?, ?, ?, ?, NULL)', [
        `m${i}`,
        s.team,
        `seat-${i}`,
        'agent',
      ]);
    for (let i = 0; i < s.lanes; i++)
      await t.run('INSERT INTO lanes VALUES (?, ?, ?, ?, ?, ?, ?)', [
        `l${i}`,
        s.team,
        `lane ${i} — why?`,
        i % 4 === 0 ? 'active' : 'done',
        `seat-${i % s.members}`,
        JSON.stringify([`packages/p${i % 9}/**`]),
        now,
      ]);
    for (let i = 0; i < s.messages; i++)
      await t.run('INSERT INTO messages VALUES (?, ?, ?, ?, ?)', [
        ulidish(i),
        s.team,
        `seat-${i % s.members}`,
        'message',
        now - (s.messages - i) * 1000,
      ]);
    for (let i = 0; i < s.audit; i++)
      await t.run('INSERT INTO audit VALUES (?, ?, ?, ?, ?)', [
        `a${ulidish(i)}`,
        s.team,
        i % 50 === 0 ? 'action.gate' : 'claim.occupied',
        JSON.stringify({
          class: i % 100 === 0 ? 'deploy' : 'merge',
          seat: `seat-${i % s.members}`,
        }),
        now - (s.audit - i) * 100,
      ]);
  });
}

function pct(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function summarize(samples) {
  const s = [...samples].sort((a, b) => a - b);
  return { p50: pct(s, 0.5), p95: pct(s, 0.95), p99: pct(s, 0.99), n: s.length };
}

function dirSizeMb(p) {
  if (!p) return 0;
  const st = statSync(p);
  if (st.isFile()) return st.size / 1e6;
  return readdirSync(p).reduce((acc, f) => acc + dirSizeMb(join(p, f)), 0);
}

export async function runBench({ backend, dir, scale = 1, rounds = 200 }) {
  mkdirSync(dir, { recursive: true });
  const s = seedRows(scale);
  const b = await openBackend(backend, dir);
  const tSeed = performance.now();
  await seed(b, backend, s);
  const seed_ms = performance.now() - tSeed;
  const queries = {};
  // Warm-up: one full pass, discarded (Review Focus 1 — WASM first-call compile is not query latency).
  for (const q of QUERY_NAMES) await b.all(QUERIES[q][0], QUERIES[q][1](s));
  for (const q of QUERY_NAMES) {
    const samples = [];
    for (let i = 0; i < rounds; i++) {
      const t0 = performance.now();
      await b.all(QUERIES[q][0], QUERIES[q][1](s));
      samples.push(performance.now() - t0);
    }
    queries[q] = summarize(samples);
  }
  const writes = [];
  for (let i = 0; i < rounds; i++) {
    const t0 = performance.now();
    await b.tx(async (t) => {
      await t.run('INSERT INTO audit VALUES (?, ?, ?, ?, ?)', [
        `w${i}-${Date.now()}`,
        s.team,
        'lane.gate',
        '{}',
        Date.now(),
      ]);
    });
    writes.push(performance.now() - t0);
  }
  const report = {
    backend,
    boot_ms: b.boot_ms,
    seed_ms,
    rows: { members: s.members, lanes: s.lanes, messages: s.messages, audit: s.audit },
    queries,
    write_commit_ms: summarize(writes),
    rss_mb: process.memoryUsage().rss / 1e6,
    disk_mb: dirSizeMb(b.file),
  };
  await b.close();
  return report;
}

export function renderMarkdown(reports) {
  const head = `| query | ${reports.map((r) => `${r.backend} p50 / p95 / p99 (ms)`).join(' | ')} |`;
  const sep = `| --- | ${reports.map(() => '---').join(' | ')} |`;
  const f = (x) => x.toFixed(3);
  const rows = QUERY_NAMES.map(
    (q) =>
      `| \`${q}\` | ${reports.map((r) => `${f(r.queries[q].p50)} / ${f(r.queries[q].p95)} / ${f(r.queries[q].p99)}`).join(' | ')} |`,
  );
  const write = `| audit insert, own tx | ${reports.map((r) => `${f(r.write_commit_ms.p50)} / ${f(r.write_commit_ms.p95)} / ${f(r.write_commit_ms.p99)}`).join(' | ')} |`;
  const meta = `| boot ms · seed s · disk MB · rss MB | ${reports.map((r) => `${r.boot_ms.toFixed(0)} · ${(r.seed_ms / 1000).toFixed(1)} · ${r.disk_mb.toFixed(1)} · ${r.rss_mb.toFixed(0)}`).join(' | ')} |`;
  const r0 = reports[0];
  return [
    `Seed: ${r0.rows.members} members · ${r0.rows.lanes} lanes · ${r0.rows.messages} messages · ${r0.rows.audit} audit rows; ${r0.queries.getPolicy.n} rounds after one warm-up.`,
    '',
    head,
    sep,
    ...rows,
    write,
    meta,
  ].join('\n');
}

if (process.argv[1] && process.argv[1].endsWith('pglite-hookpath.mjs')) {
  const scale = Number(process.argv[2] ?? 1);
  const rounds = Number(process.argv[3] ?? 200);
  const dir = join(process.env.TMPDIR ?? '/tmp', `pglite-hookpath-${Date.now()}`);
  const reports = [];
  for (const backend of ['sqlite', 'pglite-file', 'pglite-memory'])
    reports.push(await runBench({ backend, dir: join(dir, backend), scale, rounds }));
  console.log(renderMarkdown(reports));
}
