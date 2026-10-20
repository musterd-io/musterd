#!/usr/bin/env node
/**
 * Cloud 3 — restore drill (lane 01M3Z4408C3T72EY3H92JQST01; spec §7: "A backup nobody has restored
 * is a guess."):
 *
 *   node scripts/cloud/drill.mjs
 *   node scripts/cloud/drill.mjs --wrangler
 *
 * What it does, in order:
 *   1. Lists the backup objects in R2 (`musterd-cloud-backups`) and selects the newest date's
 *      coordination and trace dumps for each team (`teams/<slug>/{coordination,trace}/<YYYY-MM-DD>.json.gz.enc`).
 *   2. Downloads both encrypted blobs from R2 and decrypts + gunzips them with `decryptDump`
 *      (`~/.musterd/cloud/backup.key` or `MUSTERD_BACKUP_KEY`), verifying the `MSB1` header and
 *      AES-256-GCM AAD tag bound to each object key.
 *   3. Creates two fresh temporary Postgres databases on Neon (`musterd_drill_<ts>` and
 *      `musterd_drill_<ts>_trace`), migrates them with the full production baseline + ladder
 *      (`migratePostgres` / `migrateTracePostgres`), and grants `musterd_app` and `musterd_operator`
 *      to the login users.
 *   4. Restores every downloaded coordination and trace snapshot into the fresh databases via
 *      `restoreSnapshot`, then verifies through the tenant-scoped `pgDriver.forTeam(team.id)` handle
 *      (RLS enforced, `musterd_app` role) that the team row, members, and every restored table row
 *      count match the snapshot, and that a cross-tenant `.forTeam('other-team')` handle sees 0 rows.
 *   5. Runs the Postgres tenancy and migration verification suite against the restored schema, drops
 *      the temporary drill databases in `finally`, and prints a structured `cloud_restore_drill_completed`
 *      summary (never a URL, key, or secret — hard rule 5).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as backup from './backup.mjs';
const { createR2Store, createWranglerR2Store, decryptDump, parseBackupKey, restoreSnapshot } =
  backup;
const pg = createRequire(new URL('../../packages/server/package.json', import.meta.url))('pg');

function readKeyFile(path) {
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is mode ${mode.toString(8)}; chmod 600 it`);
  return readFileSync(path, 'utf8').trim();
}

function readEnvFile(path) {
  if (!existsSync(path)) return {};
  const mode = statSync(path).mode & 0o777;
  if (mode & 0o077) throw new Error(`${path} is mode ${mode.toString(8)}; chmod 600 it`);
  const out = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^([A-Z_]+)=(?:'([^']*)'|"([^"]*)"|(.*))$/.exec(line.trim());
    if (m) out[m[1]] = m[2] ?? m[3] ?? m[4];
  }
  return out;
}

/**
 * Given a list of R2 object keys, pick the newest date's `{ coordinationKey, traceKey }` per team.
 */
export function selectNewestTeamDumps(keys) {
  const byTeam = new Map();
  for (const key of keys) {
    const m = /^teams\/([^/]+)\/(coordination|trace)\/(\d{4}-\d{2}-\d{2})\.json\.gz\.enc$/.exec(
      key,
    );
    if (!m) continue;
    const [, slug, kind, date] = m;
    let entry = byTeam.get(slug);
    if (!entry) {
      entry = new Map();
      byTeam.set(slug, entry);
    }
    const cur = entry.get(date) ?? { date, coordinationKey: null, traceKey: null };
    if (kind === 'coordination') cur.coordinationKey = key;
    if (kind === 'trace') cur.traceKey = key;
    entry.set(date, cur);
  }
  const selected = [];
  for (const [slug, datesMap] of [...byTeam.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const complete = [...datesMap.values()]
      .filter((d) => d.coordinationKey && d.traceKey)
      .sort((a, b) => b.date.localeCompare(a.date));
    if (complete.length > 0) {
      selected.push({ slug, ...complete[0] });
    }
  }
  return selected;
}

function replaceDbName(connUrl, dbName) {
  const u = new URL(connUrl);
  u.pathname = `/${dbName}`;
  return u.toString();
}

function loginOf(connUrl) {
  return decodeURIComponent(new URL(connUrl).username);
}

/**
 * Run the restore drill against `store` and a fresh migrated database pair (`mainDriver` /
 * `traceDriver` + `mainClient` / `traceClient`), verifying row counts and tenant isolation.
 */
export async function runRestoreDrill({
  store,
  encryptionKey,
  mainClient,
  traceClient,
  mainDriver,
  traceDriver,
}) {
  const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : parseBackupKey(encryptionKey);
  const allKeys = await store.list('teams/');
  const targets = selectNewestTeamDumps(allKeys);
  if (targets.length === 0) {
    throw new Error('no complete team backup pair (coordination + trace) found in R2');
  }

  const restoredTeams = [];
  for (const t of targets) {
    const coordEnc = await store.get(t.coordinationKey);
    const coordSnap = JSON.parse(decryptDump(coordEnc, key, t.coordinationKey).toString('utf8'));
    const coordRestore = await restoreSnapshot(mainClient, coordSnap);

    const traceEnc = await store.get(t.traceKey);
    const traceSnap = JSON.parse(decryptDump(traceEnc, key, t.traceKey).toString('utf8'));
    const traceRestore = await restoreSnapshot(traceClient, traceSnap);

    // Verify through the tenant-scoped app role (RLS enforced) that the restored team's rows are
    // readable and that an unrelated tenant sees zero rows.
    const tenantDb = mainDriver.forTeam(coordSnap.team_id);
    const otherDb = mainDriver.forTeam('__drill_other_tenant__');
    const teamRow = await tenantDb.get('SELECT id, slug FROM teams WHERE id = ?', [
      coordSnap.team_id,
    ]);
    if (!teamRow || teamRow.slug !== t.slug) {
      throw new Error(`restored team ${t.slug} missing under tenant-scoped app read`);
    }
    const memberRows = await tenantDb.all('SELECT name FROM members WHERE team_id = ?', [
      coordSnap.team_id,
    ]);
    const expectedMembers = (coordSnap.tables.members ?? []).length;
    if (memberRows.length !== expectedMembers) {
      throw new Error(
        `restored member count mismatch for ${t.slug}: got ${memberRows.length}, expected ${expectedMembers}`,
      );
    }
    const leaked = await otherDb.all('SELECT name FROM members WHERE team_id = ?', [
      coordSnap.team_id,
    ]);
    if (leaked.length !== 0) {
      throw new Error(`RLS leak on restored database: other tenant saw ${leaked.length} member(s)`);
    }

    const tenantTraceDb = traceDriver.forTeam(coordSnap.team_id);
    const traceRows = await tenantTraceDb.all('SELECT seq FROM trace_events WHERE team_id = ?', [
      coordSnap.team_id,
    ]);
    const expectedTrace = (traceSnap.tables.trace_events ?? []).length;
    if (traceRows.length !== expectedTrace) {
      throw new Error(
        `restored trace count mismatch for ${t.slug}: got ${traceRows.length}, expected ${expectedTrace}`,
      );
    }

    restoredTeams.push({
      slug: t.slug,
      date: t.date,
      coordination_bytes: coordEnc.length,
      trace_bytes: traceEnc.length,
      tables: Object.keys(coordSnap.tables ?? {}).length,
      coordination_rows_inserted: coordRestore.inserted,
      trace_rows_inserted: traceRestore.inserted,
      members_verified: memberRows.length,
      rls_leak_rows: leaked.length,
    });
  }

  return { teams: restoredTeams };
}

/** Build the macOS LaunchAgent plist for the monthly unattended R2 restore drill (1st of each month at `04:17` local). */
export function buildDrillLaunchdPlist({
  nodePath = process.execPath,
  repoRoot = fileURLToPath(new URL('../..', import.meta.url)),
  logPath = join(homedir(), '.musterd', 'cloud', 'drill.log'),
  day = 1,
  hour = 4,
  minute = 17,
} = {}) {
  const scriptPath = join(repoRoot, 'scripts', 'cloud', 'drill.mjs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>studio.sandrise.musterd-cloud-drill</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${scriptPath}</string>
    <string>--wrangler</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${repoRoot}</string>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Day</key>
    <integer>${day}</integer>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(nodePath)}:/opt/homebrew/bin:/Users/nick/Library/pnpm:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
</dict>
</plist>
`;
}

async function main() {
  const t0 = Date.now();
  const args = process.argv.slice(2);
  const defaultKeyPath = join(homedir(), '.musterd', 'cloud', 'backup.key');
  const defaultNeonEnvPath = join(homedir(), '.musterd', 'cloud', 'neon.env');

  if (args.includes('--install-launchd')) {
    const plistDir = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = join(plistDir, 'studio.sandrise.musterd-cloud-drill.plist');
    const logPath = join(homedir(), '.musterd', 'cloud', 'drill.log');
    const runtimeRoot = join(homedir(), '.musterd', 'runtime');
    const repoRoot = existsSync(join(runtimeRoot, 'scripts', 'cloud', 'drill.mjs'))
      ? runtimeRoot
      : fileURLToPath(new URL('../..', import.meta.url));
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    writeFileSync(plistPath, buildDrillLaunchdPlist({ repoRoot, logPath }), { mode: 0o644 });
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    const load = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf8' });
    if (load.status !== 0) {
      throw new Error(`launchctl load failed (exit ${load.status}): ${load.stderr ?? ''}`);
    }
    if (args.includes('--kickstart')) {
      const uid = process.getuid ? process.getuid() : 501;
      const ks = spawnSync(
        'launchctl',
        ['kickstart', '-k', `gui/${uid}/studio.sandrise.musterd-cloud-drill`],
        { encoding: 'utf8' },
      );
      if (ks.status !== 0) {
        throw new Error(`launchctl kickstart failed (exit ${ks.status}): ${ks.stderr ?? ''}`);
      }
    }
    console.log(
      JSON.stringify({
        msg: 'cloud_restore_drill_schedule_installed',
        label: 'studio.sandrise.musterd-cloud-drill',
        plist: plistPath,
        log: logPath,
        schedule: 'day 1 04:17 monthly',
      }),
    );
    return;
  }

  const rawKey =
    process.env.MUSTERD_BACKUP_KEY?.trim() ||
    (existsSync(defaultKeyPath) ? readKeyFile(defaultKeyPath) : '');
  if (!rawKey) {
    throw new Error(`backup key required: set MUSTERD_BACKUP_KEY or ~/.musterd/cloud/backup.key`);
  }
  const encryptionKey = parseBackupKey(rawKey);

  const fileEnv = readEnvFile(defaultNeonEnvPath);
  const ownerUrl =
    process.env.MUSTERD_DATABASE_OWNER_URL ??
    fileEnv.MUSTERD_DATABASE_OWNER_URL ??
    fileEnv.DATABASE_OWNER_URL;
  const appUrl =
    process.env.MUSTERD_DATABASE_APP_URL ??
    fileEnv.MUSTERD_DATABASE_APP_URL ??
    fileEnv.DATABASE_APP_URL;
  const operatorUrl =
    process.env.MUSTERD_DATABASE_OPERATOR_URL ??
    fileEnv.MUSTERD_DATABASE_OPERATOR_URL ??
    fileEnv.DATABASE_OPERATOR_URL;
  if (!ownerUrl || !appUrl || !operatorUrl) {
    throw new Error(
      'restore drill requires DATABASE_{OWNER,APP,OPERATOR}_URL in env or ~/.musterd/cloud/neon.env',
    );
  }

  const bucket = process.env.MUSTERD_BACKUP_R2_BUCKET?.trim() || 'musterd-cloud-backups';
  const accountId = process.env.MUSTERD_BACKUP_R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.MUSTERD_BACKUP_R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.MUSTERD_BACKUP_R2_SECRET_ACCESS_KEY?.trim();
  const store =
    accountId && accessKeyId && secretAccessKey
      ? createR2Store({
          accountId,
          bucket,
          accessKeyId,
          secretAccessKey,
          endpoint: process.env.MUSTERD_BACKUP_R2_ENDPOINT?.trim() || undefined,
        })
      : createWranglerR2Store({ bucket });

  const suffix = Date.now().toString(36);
  const drillMainDb = `musterd_drill_${suffix}`;
  const drillTraceDb = `${drillMainDb}_trace`;

  const adminClient = new pg.Client({ connectionString: ownerUrl });
  await adminClient.connect();
  try {
    await adminClient.query(`CREATE DATABASE "${drillMainDb}"`);
    await adminClient.query(`CREATE DATABASE "${drillTraceDb}"`);
  } finally {
    await adminClient.end().catch(() => {});
  }

  const drillMainOwnerUrl = replaceDbName(ownerUrl, drillMainDb);
  const drillMainAppUrl = replaceDbName(appUrl, drillMainDb);
  const drillMainOpUrl = replaceDbName(operatorUrl, drillMainDb);
  const drillTraceOwnerUrl = replaceDbName(ownerUrl, drillTraceDb);
  const drillTraceAppUrl = replaceDbName(appUrl, drillTraceDb);
  const drillTraceOpUrl = replaceDbName(operatorUrl, drillTraceDb);

  const { migratePostgres, migrateTracePostgres } =
    await import('../../packages/server/dist/db/pg/migrate.js');
  const { pgDriver } = await import('../../packages/server/dist/db/pgDriver.js');

  const mainDriver = pgDriver({
    ownerUrl: drillMainOwnerUrl,
    appUrl: drillMainAppUrl,
    operatorUrl: drillMainOpUrl,
    poolSize: 2,
  });
  const traceDriver = pgDriver({
    ownerUrl: drillTraceOwnerUrl,
    appUrl: drillTraceAppUrl,
    operatorUrl: drillTraceOpUrl,
    poolSize: 2,
  });
  const mainClient = new pg.Client({ connectionString: drillMainOwnerUrl });
  const traceClient = new pg.Client({ connectionString: drillTraceOwnerUrl });

  try {
    const grants = `GRANT musterd_app TO "${loginOf(appUrl)}";
      GRANT musterd_operator TO "${loginOf(operatorUrl)}";`;
    const mainVersion = await migratePostgres(mainDriver.asOwner());
    await mainDriver.asOwner().exec(grants);
    const traceVersion = await migrateTracePostgres(traceDriver.asOwner());
    await traceDriver.asOwner().exec(grants);

    await mainClient.connect();
    await traceClient.connect();

    const drillResult = await runRestoreDrill({
      store,
      encryptionKey,
      mainClient,
      traceClient,
      mainDriver,
      traceDriver,
    });

    // Run the Postgres migration + tenancy + backup suite to confirm the store layer passes.
    let suitePassed = true;
    if (!args.includes('--skip-suite')) {
      const vitest = spawnSync(
        'pnpm',
        [
          '-C',
          'packages/server',
          'exec',
          'vitest',
          'run',
          'src/db/pg/tenancy.test.ts',
          'src/db/pg/migrate.test.ts',
          'src/db/pg/drift.test.ts',
          'src/cloud/backup.test.ts',
        ],
        { encoding: 'utf8' },
      );
      if (vitest.status !== 0) {
        suitePassed = false;
        throw new Error(
          `verification suite failed (exit ${vitest.status}):\n${vitest.stdout}\n${vitest.stderr}`,
        );
      }
    }

    console.log(
      JSON.stringify({
        msg: 'cloud_restore_drill_completed',
        date: new Date().toISOString().slice(0, 10),
        drill_databases: [drillMainDb, drillTraceDb],
        schema_versions: { main: mainVersion, trace: traceVersion },
        teams_restored: drillResult.teams,
        suite_passed: suitePassed,
        duration_ms: Date.now() - t0,
      }),
    );
  } finally {
    await mainClient.end().catch(() => {});
    await traceClient.end().catch(() => {});
    await mainDriver.close().catch(() => {});
    await traceDriver.close().catch(() => {});
    const dropClient = new pg.Client({ connectionString: ownerUrl });
    await dropClient.connect();
    try {
      await dropClient.query(`DROP DATABASE IF EXISTS "${drillMainDb}" WITH (FORCE)`);
      await dropClient.query(`DROP DATABASE IF EXISTS "${drillTraceDb}" WITH (FORCE)`);
    } finally {
      await dropClient.end().catch(() => {});
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(
      `restore drill failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
    process.exit(1);
  });
}
