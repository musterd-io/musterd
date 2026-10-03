#!/usr/bin/env node
/**
 * The by-hand real-Postgres pass (cloud increment 1B, task 14): migrate a Neon project with the
 * frozen baseline + ladder as the OWNER, grant the app/operator roles to their login users, then
 * run the tenancy leak test, the Postgres driver tests and the whole server store suite with
 * `MUSTERD_TEST_DRIVER=pg`. Prints a summary for docs/perf/neon-pass.md — never a URL.
 *
 *   node scripts/cloud/neon-pass.mjs            # the whole pass
 *   node scripts/cloud/neon-pass.mjs --migrate  # migrate + grant only
 *   node scripts/cloud/neon-pass.mjs --repair   # … replaying the ladder when the catalog lacks a
 *                                               # column the version row claims (ADR 496)
 *   node scripts/cloud/neon-pass.mjs --per-file # each store file alone, capped (FILE_CAP_S, 240)
 *   node scripts/cloud/neon-pass.mjs --per-file --only lanes,orientation   # just those files
 *
 * --per-file prints, under each failing file, its failures grouped by error message and the
 * statement that raised it (vitest's JSON report), so one run classifies every failure.
 *
 * Reads ~/.musterd/cloud/neon.env (mode 600, refused otherwise):
 *   DATABASE_OWNER_URL='postgres://<owner login>:…@<direct host>/musterd'
 *   DATABASE_APP_URL='postgres://<app login>:…@<pooled host>/musterd'
 *   DATABASE_OPERATOR_URL='postgres://<operator login>:…@<pooled host>/musterd'
 * or, on a bench machine (scripts/cloud/bench-run.mjs), the same three names as environment
 * variables, which are written to that file first. The trace store (ADR 445 §3) is its own
 * database, `<db>_trace`, created here if missing.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { migratePostgres, migrateTracePostgres } from '../../packages/server/dist/db/pg/migrate.js';
import { pgDriver } from '../../packages/server/dist/db/pgDriver.js';

// `pg` is @musterd/server's dependency (ADR 486), resolved from there — the repo root has none.
const pg = createRequire(new URL('../../packages/server/package.json', import.meta.url))('pg');

const ENV = join(homedir(), '.musterd', 'cloud', 'neon.env');
const KEYS = ['DATABASE_OWNER_URL', 'DATABASE_APP_URL', 'DATABASE_OPERATOR_URL'];

/**
 * On a bench machine (scripts/cloud/bench-run.mjs) the URLs arrive as Fly secrets, not a file, and
 * `db/testing.ts` reads only the file. So when all three are in the environment and no file exists,
 * write it — mode 600, never printed — and every test process finds what a laptop run would.
 */
function materializeEnvFile(path = ENV) {
  if (existsSync(path) || !KEYS.every((k) => process.env[k])) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, KEYS.map((k) => `${k}='${process.env[k]}'`).join('\n') + '\n', {
    mode: 0o600,
  });
}

export function readNeonEnv(path = ENV) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is mode ${mode.toString(8)}; chmod 600 it`);
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(?:'([^']*)'|"([^"]*)"|(.*))$/.exec(line.trim());
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  for (const k of KEYS) if (!out[k]) throw new Error(`${path} lacks ${k}`);
  return out;
}

const loginOf = (url) => decodeURIComponent(new URL(url).username);
const traceUrlOf = (url) => {
  const u = new URL(url);
  u.pathname = `${u.pathname}_trace`;
  return u.toString();
};
const dbNameOf = (url) => new URL(url).pathname.replace(/^\//, '');

async function ensureDatabase(ownerUrl, name) {
  // CREATE DATABASE cannot run inside a transaction, so this one statement bypasses the Driver.
  const c = new pg.Client({ connectionString: ownerUrl });
  await c.connect();
  try {
    const r = await c.query('SELECT 1 FROM pg_database WHERE datname = $1', [name]);
    if (r.rowCount === 0) await c.query(`CREATE DATABASE "${name}"`);
  } finally {
    await c.end();
  }
}

async function migrateAndGrant(env) {
  const t0 = Date.now();
  await ensureDatabase(env.DATABASE_OWNER_URL, `${dbNameOf(env.DATABASE_OWNER_URL)}_trace`);
  const grants = `GRANT musterd_app TO "${loginOf(env.DATABASE_APP_URL)}";
    GRANT musterd_operator TO "${loginOf(env.DATABASE_OPERATOR_URL)}";`;
  const main = pgDriver({
    appUrl: env.DATABASE_APP_URL,
    operatorUrl: env.DATABASE_OPERATOR_URL,
    ownerUrl: env.DATABASE_OWNER_URL,
    poolSize: 2,
  });
  const trace = pgDriver({
    appUrl: traceUrlOf(env.DATABASE_APP_URL),
    operatorUrl: traceUrlOf(env.DATABASE_OPERATOR_URL),
    ownerUrl: traceUrlOf(env.DATABASE_OWNER_URL),
    poolSize: 2,
  });
  try {
    const ladder = {
      repair: process.argv.includes('--repair'),
      report: (line) => console.log(line),
    };
    const mainVersion = await migratePostgres(main.asOwner(), ladder);
    await main.asOwner().exec(grants);
    const traceVersion = await migrateTracePostgres(trace.asOwner(), ladder);
    await trace.asOwner().exec(grants);
    const v = await main.asOwner().get('SELECT version() AS v');
    return { mainVersion, traceVersion, server: v?.v, migrateMs: Date.now() - t0 };
  } finally {
    await main.close();
    await trace.close();
  }
}

/**
 * The failed tests of one vitest run, from its JSON report: name, the first line of the error, and
 * the statement the driver appended (`in: <sql>`) — what the summary line hides, and the only way
 * to tell a driver bug from a test-isolation tail without rerunning a file by hand.
 */
function failedTests(jsonPath) {
  if (!existsSync(jsonPath)) return [];
  const esc = String.fromCharCode(27);
  const strip = (s) =>
    s
      .split(esc)
      .map((part, i) => (i ? part.replace(/^\[[0-9;]*m/, '') : part))
      .join('');
  const report = JSON.parse(readFileSync(jsonPath, 'utf8'));
  unlinkSync(jsonPath);
  const out = [];
  for (const file of report.testResults ?? []) {
    for (const t of file.assertionResults ?? []) {
      if (t.status !== 'failed') continue;
      const text = strip(t.failureMessages?.[0] ?? '(no message)');
      const lines = text.split('\n').map((l) => l.trim());
      const message = lines.find((l) => l && !l.startsWith('at ')) ?? '(no message)';
      const sql = lines.find((l) => l.startsWith('in: '))?.slice(4) ?? null;
      out.push({ name: t.fullName ?? t.title, message, sql });
    }
  }
  return out;
}

/** The failures of a file grouped by error, most frequent first, one example test per group. */
function digest(failed, max = 6) {
  const groups = new Map();
  for (const f of failed) {
    const key = `${f.message.slice(0, 160)}${f.sql ? ` ⟂ ${f.sql.slice(0, 120)}` : ''}`;
    const g = groups.get(key) ?? { key, count: 0, example: f.name };
    g.count++;
    groups.set(key, g);
  }
  return [...groups.values()]
    .sort((a, b) => b.count - a.count)
    .slice(0, max)
    .map((g) => `   ${String(g.count).padStart(3)}× ${g.key}\n        e.g. ${g.example}`);
}

function runVitest(label, args, { timeoutMs, json } = {}) {
  const t0 = Date.now();
  const reporters = json
    ? ['--reporter=default', '--reporter=json', `--outputFile.json=${json}`]
    : [];
  // ONE worker: unlike the PGlite double (one instance per worker), real Postgres is one database
  // for every worker, and a second worker's TRUNCATE wipes the first's team mid-test.
  const r = spawnSync(
    'npx',
    ['vitest', 'run', '--maxWorkers=1', '--no-file-parallelism', ...reporters, ...args],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, MUSTERD_TEST_DRIVER: 'pg', CI: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
      ...(timeoutMs ? { timeout: timeoutMs, killSignal: 'SIGKILL' } : {}),
    },
  );
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const tests = /Tests\s+(.*)/.exec(out)?.[1] ?? '(no summary)';
  const files = /Test Files\s+(.*)/.exec(out)?.[1] ?? '(no summary)';
  const failures = [...out.matchAll(/^ FAIL .*$/gm)].map((m) => m[0]);
  const timedOut = r.error?.code === 'ETIMEDOUT' || r.signal === 'SIGKILL';
  const failed = json ? failedTests(json) : [];
  return { label, status: r.status, files, tests, ms: Date.now() - t0, failures, timedOut, failed };
}

materializeEnvFile();
const env = readNeonEnv();
const migrated = await migrateAndGrant(env);
console.log(
  `migrated: main v${migrated.mainVersion}, trace v${migrated.traceVersion} in ${migrated.migrateMs} ms`,
);
console.log(`server: ${migrated.server}`);
if (process.argv.includes('--migrate')) process.exit(0);

/**
 * --per-file: every store test file on its own, capped at FILE_CAP_S (default 240 s) — how the
 * 2026-09-30 pass had to be finished by hand once the whole-suite run hung. One verdict line per
 * file, so a slow file never hides the files after it.
 */
if (process.argv.includes('--per-file')) {
  const cap = Number(process.env.FILE_CAP_S ?? 240) * 1000;
  const dir = 'packages/server/src/store';
  const root = new URL('../..', import.meta.url).pathname;
  // --only a,b,c: just the files whose name contains one of the tokens (a rerun of the failures).
  const onlyAt = process.argv.indexOf('--only');
  const only = onlyAt >= 0 ? (process.argv[onlyAt + 1] ?? '').split(',').filter(Boolean) : [];
  const files = readdirSync(join(root, dir))
    .filter((n) => n.endsWith('.test.ts'))
    .filter((n) => !only.length || only.some((t) => n.includes(t)))
    .sort();
  const json = (name) => join(tmpdir(), `neon-pass-${name}.json`);
  const tally = { pass: 0, fail: 0, timeout: 0 };
  const base = runVitest('tenancy + pg', [
    'packages/server/src/db/tenancy.test.ts',
    'packages/server/src/db/pg',
    'packages/server/src/db/pgliteDriver.test.ts',
  ]);
  console.log(`tenancy + pg: exit ${base.status}, ${base.tests}`);
  for (const f of base.failures) console.log(`   ${f}`);
  for (const [i, name] of files.entries()) {
    const r = runVitest(name, [`${dir}/${name}`], { timeoutMs: cap, json: json(name) });
    const verdict = r.timedOut ? 'TIMEOUT' : r.status === 0 ? 'PASS' : 'FAIL';
    tally[verdict.toLowerCase()]++;
    console.log(
      `[${i + 1}/${files.length}] ${verdict.padEnd(7)} ${name} ${Math.round(r.ms / 1000)} s — ${r.tests}`,
    );
    for (const line of digest(r.failed)) console.log(line);
    if (verdict === 'FAIL' && !r.failed.length)
      for (const f of r.failures.slice(0, 5)) console.log(`   ${f}`);
  }
  console.log(
    `\nper-file: ${files.length} files — ${tally.pass} pass, ${tally.fail} fail, ${tally.timeout} timeout (cap ${cap / 1000} s)`,
  );
  process.exit(base.status === 0 && tally.fail + tally.timeout === 0 ? 0 : 1);
}

const runs = [
  runVitest('tenancy + pg', [
    'packages/server/src/db/tenancy.test.ts',
    'packages/server/src/db/pg',
    'packages/server/src/db/pgliteDriver.test.ts',
  ]),
  runVitest('server store suite', ['packages/server/src/store']),
];
for (const r of runs) {
  console.log(`\n== ${r.label}: exit ${r.status}, ${Math.round(r.ms / 1000)} s`);
  console.log(`   files: ${r.files}\n   tests: ${r.tests}`);
  for (const f of r.failures) console.log(`   ${f}`);
}
process.exit(runs.every((r) => r.status === 0) ? 0 : 1);
