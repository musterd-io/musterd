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
 *
 * Reads ~/.musterd/cloud/neon.env (mode 600, refused otherwise):
 *   DATABASE_OWNER_URL='postgres://<owner login>:…@<direct host>/musterd'
 *   DATABASE_APP_URL='postgres://<app login>:…@<pooled host>/musterd'
 *   DATABASE_OPERATOR_URL='postgres://<operator login>:…@<pooled host>/musterd'
 * The trace store (ADR 445 §3) is its own database, `<db>_trace`, created here if missing.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { migratePostgres, migrateTracePostgres } from '../../packages/server/dist/db/pg/migrate.js';
import { pgDriver } from '../../packages/server/dist/db/pgDriver.js';

// `pg` is @musterd/server's dependency (ADR 486), resolved from there — the repo root has none.
const pg = createRequire(new URL('../../packages/server/package.json', import.meta.url))('pg');

const ENV = join(homedir(), '.musterd', 'cloud', 'neon.env');

export function readNeonEnv(path = ENV) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is mode ${mode.toString(8)}; chmod 600 it`);
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(?:'([^']*)'|"([^"]*)"|(.*))$/.exec(line.trim());
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  for (const k of ['DATABASE_OWNER_URL', 'DATABASE_APP_URL', 'DATABASE_OPERATOR_URL'])
    if (!out[k]) throw new Error(`${path} lacks ${k}`);
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

function runVitest(label, args) {
  const t0 = Date.now();
  // ONE worker: unlike the PGlite double (one instance per worker), real Postgres is one database
  // for every worker, and a second worker's TRUNCATE wipes the first's team mid-test.
  const r = spawnSync(
    'npx',
    ['vitest', 'run', '--maxWorkers=1', '--no-file-parallelism', ...args],
    {
      cwd: new URL('../..', import.meta.url).pathname,
      env: { ...process.env, MUSTERD_TEST_DRIVER: 'pg', CI: '1' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const out = r.stdout + r.stderr;
  const tests = /Tests\s+(.*)/.exec(out)?.[1] ?? '(no summary)';
  const files = /Test Files\s+(.*)/.exec(out)?.[1] ?? '(no summary)';
  const failures = [...out.matchAll(/^ FAIL .*$/gm)].map((m) => m[0]);
  return { label, status: r.status, files, tests, ms: Date.now() - t0, failures };
}

const env = readNeonEnv();
const migrated = await migrateAndGrant(env);
console.log(
  `migrated: main v${migrated.mainVersion}, trace v${migrated.traceVersion} in ${migrated.migrateMs} ms`,
);
console.log(`server: ${migrated.server}`);
if (process.argv.includes('--migrate')) process.exit(0);

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
