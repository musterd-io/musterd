#!/usr/bin/env node
/**
 * Wake-lease poll, before and after #2511 (lane 01M562HNQF47JM32EAVVHZMTAA, goal live-loads-fast).
 *
 *   node scripts/perf/wake-lease-stale-stats.mjs <repo> <db> <runs> <ref>
 *
 * Every wake-lease poll runs `openDirectedLedger`, whose "answered by anyone" clause #2511 found
 * mis-planned on the hub: `messages` had planner statistics from 17,207 rows, v93 added
 * `idx_messages_thread_act_ts` without an ANALYZE, and the missing row made that index win. The fix
 * is a post-ladder `ANALYZE` of any table whose statistics miss an index. The hub's database is not
 * on this machine, so this copies <db>, loads the hub's `sqlite_stat1` for `messages` (the same rows
 * `db.test.ts` loads) after `openDb`, and times `openDirectedLedger` in two conditions, round-robin,
 * in fresh processes: `before` leaves the statistics stale, which is what the daemon's start did before
 * #2511; `after` runs `analyzeTablesMissingIndexStats`, which is what its start does now. One build
 * of <ref> serves both, because #2511 changed nothing but that step: a pre-#2511 build refuses this
 * database (schema 106 against its 94), and the ledger SQL is identical on both sides of the PR.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const [repo, db, runsArg, ...rest] = process.argv.slice(2);
const runs = Number(runsArg);
const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'musterd-wake-')));

if (process.env.WAKE_CHILD) {
  // child: <dist> <dbcopy>
  const [dist, copy, cond] = process.argv.slice(2);
  const { openDb } = await import(join(dist, 'db/open.js'));
  const { analyzeTablesMissingIndexStats } = await import(join(dist, 'db/migrations.js'));
  const { sqliteDriver } = await import(join(dist, 'db/sqliteDriver.js'));
  const raw = openDb(copy);
  raw.exec(`
    DELETE FROM sqlite_stat1 WHERE tbl = 'messages';
    INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES
      ('messages', 'idx_messages_from_act_ts', '17207 638 96 1 1'),
      ('messages', 'idx_messages_thread_act', '17207 4302 717 50'),
      ('messages', 'idx_messages_thread_from', '17207 4302 62 50 1'),
      ('messages', 'idx_messages_from_reply', '17207 4302 638 15'),
      ('messages', 'idx_messages_in_reply_to', '17207 4302 16'),
      ('messages', 'idx_messages_team_created', '17207 4302 1'),
      ('messages', 'idx_messages_to_member', '17207 638'),
      ('messages', 'idx_messages_thread', '17207 63'),
      ('messages', 'idx_messages_team_ts', '17207 4302 1'),
      ('messages', 'sqlite_autoindex_messages_1', '17207 1');
    ANALYZE sqlite_schema;`);
  const t0 = performance.now();
  if (cond === 'after') analyzeTablesMissingIndexStats(raw);
  const migrateMs = performance.now() - t0;
  const { openDirectedLedger } = await import(join(dist, 'store/delivery.js'));
  const driver = sqliteDriver(raw); // the same connection: reopening would run the ladder, and the fix, in both conditions
  const team = await driver.get("SELECT id FROM teams WHERE slug = 'revive'", []);
  const t1 = performance.now();
  const rows = await openDirectedLedger(driver, team.id);
  console.log(JSON.stringify({ migrateMs, ledgerMs: performance.now() - t1, rows: rows.length }));
  process.exit(0);
}

const ref = rest[0];
const dir = join(scratch, 'build');
sh('git', ['worktree', 'add', '--detach', '--quiet', dir, ref], repo);
sh(
  'pnpm',
  ['install', '--frozen-lockfile', '--prefer-offline', '--filter', '@musterd/server...'],
  dir,
);
sh('pnpm', ['--filter', '@musterd/server...', 'build'], dir);
const sha = sh('git', ['rev-parse', '--short', 'HEAD'], dir).trim();
const dist = join(dir, 'packages/server/dist');
const sides = ['before', 'after'].map((label) => ({ label, ms: [], mig: [], rows: 0 }));
for (let i = 0; i < runs; i++) {
  for (const s of sides) {
    const copy = join(scratch, `${s.label}-${i}.db`);
    copyFileSync(db, copy);
    const out = JSON.parse(
      execFileSync('node', [process.argv[1], dist, copy, s.label], {
        encoding: 'utf8',
        env: { ...process.env, WAKE_CHILD: '1' },
      })
        .trim()
        .split('\n')
        .at(-1),
    );
    s.ms.push(out.ledgerMs);
    s.mig.push(out.migrateMs);
    s.rows = out.rows;
  }
}
const median = (xs) => {
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};
const r1 = (n) => Math.round(n * 10) / 10;
console.log(
  JSON.stringify(
    {
      sha,
      runs,
      conditions: sides.map((s) => ({
        label: s.label,
        ledger_ms_median: r1(median(s.ms)),
        ledger_ms_min: r1(Math.min(...s.ms)),
        ledger_ms_max: r1(Math.max(...s.ms)),
        analyze_ms_median: r1(median(s.mig)),
        rows: s.rows,
      })),
    },
    null,
    2,
  ),
);
