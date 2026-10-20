#!/usr/bin/env node
/**
 * Cloud 3 — nightly encrypted database backups to Cloudflare R2 (ADR 679; spec §7 + §4.8,
 * amended 2026-10-20 per nick: bucket in the existing Cloudflare account, bucket-scoped token,
 * client-side AES-256-GCM encryption so R2 only ever holds ciphertext).
 *
 *   node scripts/cloud/backup.mjs               # dump, encrypt, upload, and prune expired objects
 *   node scripts/cloud/backup.mjs --dry-run     # dump + encrypt in memory, print counts (no R2 write)
 *   node scripts/cloud/backup.mjs --keygen      # write a fresh 32-byte key to ~/.musterd/cloud/backup.key
 *
 * What is backed up on each run:
 *   - Per active team (`SELECT id, slug FROM teams WHERE archived_at IS NULL`):
 *     1. `teams/<slug>/coordination/<YYYY-MM-DD>.json.gz.enc` — every team-owned table in the
 *        coordination database (`teams` row + every table carrying `team_id = <id>`), gzipped and
 *        AES-256-GCM encrypted. Kept 30 days (`COORDINATION_RETENTION_DAYS = 30`).
 *     2. `teams/<slug>/trace/<YYYY-MM-DD>.json.gz.enc` — the team's `trace_events` rows from the
 *        captured-content database, gzipped and AES-256-GCM encrypted. Kept 7 days
 *        (`TRACE_RETENTION_DAYS = 7`, spec §4.8: "deleted content is gone from backups within 7 days").
 *   - Optional `MUSTERD_CONSOLE_DATABASE_OWNER_URL`:
 *     3. `console/<YYYY-MM-DD>.json.gz.enc` — `console_meta`, `accounts`, `identities`, and `audit`
 *        from the console database (`sessions`, `auth_transactions`, and `rate_limits` are omitted
 *        so a restore never revives consumed tokens or sessions — ADR 615 decision 9). Kept 30 days.
 *   - Optional `pg_dump` full-database custom dump when `MUSTERD_BACKUP_PG_DUMP=1` and `pg_dump` is
 *     on PATH: `pg_dump/coordination/<YYYY-MM-DD>.dump.enc` (30d) and `pg_dump/trace/<YYYY-MM-DD>.dump.enc` (7d).
 *
 * Hard rule 5: no database URL, encryption key, or R2 secret is ever logged or echoed.
 */
import { spawnSync } from 'node:child_process';
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';

export const COORDINATION_RETENTION_DAYS = 30;
export const TRACE_RETENTION_DAYS = 7;
export const CONSOLE_RETENTION_DAYS = 30;

/** Magic header on every encrypted dump: `MSB1` (musterd backup v1) + 12-byte IV + 16-byte GCM tag + ciphertext. */
const MAGIC = Buffer.from('MSB1', 'ascii');
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Parse a 32-byte key from hex (64 chars) or base64/base64url. Never echoes the input on error. */
export function parseBackupKey(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) throw new Error('backup encryption key is empty');
  const buf = /^[0-9a-fA-F]{64}$/.test(trimmed)
    ? Buffer.from(trimmed, 'hex')
    : Buffer.from(trimmed, 'base64');
  if (buf.length !== 32) {
    throw new Error(`backup encryption key must decode to 32 bytes (got ${buf.length})`);
  }
  return buf;
}

/**
 * Compress `plaintext` (Buffer or string) with gzip and encrypt with AES-256-GCM.
 * Format: `MSB1` (4B) || IV (12B) || AuthTag (16B) || Ciphertext.
 * `aad` binds the object key (e.g. `teams/revive/coordination/2026-10-20.json.gz.enc`) so a dump
 * cannot be swapped across teams, stores, or dates without failing authentication.
 */
export function encryptDump(plaintext, key, aad = '') {
  const keyBuf = Buffer.isBuffer(key) ? key : parseBackupKey(key);
  if (keyBuf.length !== 32) throw new Error('encryptDump requires a 32-byte key');
  const compressed = gzipSync(
    Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(String(plaintext), 'utf8'),
  );
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
  const body = Buffer.concat([cipher.update(compressed), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([MAGIC, iv, tag, body]);
}

/**
 * Decrypt and gunzip a buffer produced by {@link encryptDump}. Refuses a wrong magic header,
 * truncated payload, tampered ciphertext, or mismatched `aad` (team/store/date swap).
 */
export function decryptDump(blob, key, aad = '') {
  const keyBuf = Buffer.isBuffer(key) ? key : parseBackupKey(key);
  if (keyBuf.length !== 32) throw new Error('decryptDump requires a 32-byte key');
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  if (buf.length < MAGIC.length + IV_BYTES + TAG_BYTES) {
    throw new Error('encrypted dump is truncated');
  }
  if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new Error('encrypted dump has an unrecognized header');
  }
  const iv = buf.subarray(MAGIC.length, MAGIC.length + IV_BYTES);
  const tag = buf.subarray(MAGIC.length + IV_BYTES, MAGIC.length + IV_BYTES + TAG_BYTES);
  const ciphertext = buf.subarray(MAGIC.length + IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv);
  if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
  decipher.setAuthTag(tag);
  const compressed = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return gunzipSync(compressed);
}

/**
 * Export one team's rows from a coordination `pg.Client` (or PGlite-backed client) as a
 * self-contained JSON snapshot: `{ version: 1, kind: 'coordination', team_id, team_slug, created_at, tables }`.
 * Discovers every table in `public` that has a `team_id` column automatically, so a new table added
 * by a later migration is backed up without editing this list.
 */
export async function exportTeamCoordination(client, teamRow, now = Date.now()) {
  const { rows: tableRows } = await client.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'team_id'
      ORDER BY table_name ASC`,
  );
  const tables = { teams: [teamRow] };
  for (const { table_name: table } of tableRows) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table)) continue;
    const { rows } = await client.query(`SELECT * FROM "${table}" WHERE team_id = $1`, [
      teamRow.id,
    ]);
    tables[table] = rows;
  }
  return {
    version: 1,
    kind: 'coordination',
    team_id: teamRow.id,
    team_slug: teamRow.slug,
    created_at: now,
    tables,
  };
}

/**
 * Export one team's rows from the captured-content trace database (`trace_events`).
 */
export async function exportTeamTrace(traceClient, teamRow, now = Date.now()) {
  const { rows } = await traceClient.query(
    'SELECT * FROM trace_events WHERE team_id = $1 ORDER BY seq ASC',
    [teamRow.id],
  );
  return {
    version: 1,
    kind: 'trace',
    team_id: teamRow.id,
    team_slug: teamRow.slug,
    created_at: now,
    tables: { trace_events: rows },
  };
}

/**
 * Export the console database (`musterd-console`, ADR 615 decision 9), deliberately excluding
 * `sessions`, `auth_transactions`, and `rate_limits` so a restore never revives a consumed token or
 * a revoked/expired session.
 */
export async function exportConsoleSnapshot(consoleClient, now = Date.now()) {
  const tables = {};
  for (const table of ['console_meta', 'accounts', 'identities', 'audit']) {
    const { rows } = await consoleClient.query(`SELECT * FROM "${table}"`);
    tables[table] = rows;
  }
  return {
    version: 1,
    kind: 'console',
    created_at: now,
    tables,
  };
}

/**
 * Restore a team's coordination or trace snapshot (from {@link decryptDump}) into `client` inside a
 * single transaction. Idempotent (`ON CONFLICT DO NOTHING`) so restoring into a fresh migrated
 * database repopulates the team cleanly.
 */
export async function restoreSnapshot(client, snapshot) {
  await client.query('BEGIN');
  try {
    // Disable FK trigger checks for the bulk load inside the restore transaction (owner role),
    // then re-enable before commit so table order inside `tables` never trips self/cross FKs.
    await client.query("SET LOCAL session_replication_role = 'replica'");
    let inserted = 0;
    for (const [table, rows] of Object.entries(snapshot.tables ?? {})) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table) || !Array.isArray(rows) || rows.length === 0) continue;
      for (const row of rows) {
        const cols = Object.keys(row).filter((c) => /^[a-z_][a-z0-9_]*$/.test(c));
        if (cols.length === 0) continue;
        const colList = cols.map((c) => `"${c}"`).join(', ');
        const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
        const values = cols.map((c) => row[c]);
        const r = await client.query(
          `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
          values,
        );
        inserted += r.rowCount ?? 0;
      }
    }
    await client.query("SET LOCAL session_replication_role = 'origin'");
    await client.query('COMMIT');
    return { inserted };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

/**
 * Decide which R2 object keys have passed their retention window:
 *   - `teams/<slug>/coordination/<YYYY-MM-DD>.json.gz.enc` → 30 days
 *   - `teams/<slug>/trace/<YYYY-MM-DD>.json.gz.enc`        → 7 days (spec §4.8)
 *   - `console/<YYYY-MM-DD>.json.gz.enc`                   → 30 days
 *   - `pg_dump/coordination/<YYYY-MM-DD>.dump.enc`         → 30 days
 *   - `pg_dump/trace/<YYYY-MM-DD>.dump.enc`                → 7 days
 *
 * An object key whose date is strictly older than `todayUtc` minus `retentionDays` is returned for
 * deletion. Unrecognized keys are left untouched.
 */
export function expiredBackupKeys(keys, todayUtc = new Date().toISOString().slice(0, 10)) {
  const [ty, tm, td] = todayUtc.split('-').map(Number);
  const todayMs = Date.UTC(ty, tm - 1, td);
  const DAY_MS = 86_400_000;
  const expired = [];
  for (const key of keys) {
    const m =
      /^(?:teams\/[^/]+\/(coordination|trace)|pg_dump\/(coordination|trace)|(console))\/(\d{4}-\d{2}-\d{2})\.[a-z0-9.]+$/.exec(
        key,
      );
    if (!m) continue;
    const kind = m[1] ?? m[2] ?? m[3];
    const dateStr = m[4];
    const [y, mo, d] = dateStr.split('-').map(Number);
    const objMs = Date.UTC(y, mo - 1, d);
    if (!Number.isFinite(objMs)) continue;
    const maxDays =
      kind === 'trace'
        ? TRACE_RETENTION_DAYS
        : kind === 'console'
          ? CONSOLE_RETENTION_DAYS
          : COORDINATION_RETENTION_DAYS;
    if (todayMs - objMs >= maxDays * DAY_MS) {
      expired.push(key);
    }
  }
  return expired;
}

/* ────────────────────── Minimal AWS SigV4 client for Cloudflare R2 ────────────────────── */

function hmac(key, data) {
  return createHmac('sha256', key).update(data).digest();
}

function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

function encodeRfc3986(str) {
  return encodeURIComponent(str).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Sign an S3-compatible request for Cloudflare R2 (`region = 'auto'`, `service = 's3'`).
 * Pure Node `crypto` — zero runtime dependencies (hard rule 6).
 */
export function signR2Request({
  method,
  url,
  accessKeyId,
  secretAccessKey,
  body = Buffer.alloc(0),
  contentType,
  now = new Date(),
}) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body);
  const headers = {
    host: u.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
    ...(contentType ? { 'content-type': contentType } : {}),
  };
  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');
  const canonicalUri = u.pathname.split('/').map(encodeRfc3986).join('/');
  const sortedParams = [...u.searchParams.entries()].sort((a, b) =>
    a[0] === b[0] ? a[1].localeCompare(b[1]) : a[0].localeCompare(b[0]),
  );
  const canonicalQuery = sortedParams
    .map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`)
    .join('&');
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, 'auto');
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function readWranglerAuth() {
  const candidates = [
    join(homedir(), 'Library', 'Preferences', '.wrangler', 'config', 'default.toml'),
    join(homedir(), '.wrangler', 'config', 'default.toml'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    const token = /^oauth_token\s*=\s*"([^"]+)"/m.exec(text)?.[1];
    if (token) return token;
  }
  return process.env.CLOUDFLARE_API_TOKEN?.trim() || null;
}

/** Build an R2 storage adapter (PUT, GET, LIST, DELETE) against `https://<accountId>.r2.cloudflarestorage.com/<bucket>` or via `wrangler r2 object` CLI + Cloudflare REST API fallback when no S3 access key is set. */
export function createWranglerR2Store({
  bucket,
  accountId = process.env.MUSTERD_BACKUP_R2_ACCOUNT_ID?.trim() ||
    '0f159d2f0622a4fef8e07d64d4a9bdb0',
  wranglerCmd = 'npx',
  fetchImpl = fetch,
}) {
  const runWrangler = (args, input) => {
    const r = spawnSync(wranglerCmd, ['wrangler', 'r2', ...args], {
      encoding: input ? undefined : 'utf8',
      input,
      maxBuffer: 256 * 1024 * 1024,
    });
    if (r.status !== 0) {
      const errText = Buffer.isBuffer(r.stderr)
        ? r.stderr.toString('utf8')
        : String(r.stderr ?? '');
      throw new Error(
        `wrangler r2 ${args[0]} failed (exit ${r.status}): ${errText.split('\n')[0]}`,
      );
    }
    return r.stdout;
  };

  return {
    async put(key, body, contentType = 'application/octet-stream') {
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      runWrangler(
        [
          'object',
          'put',
          `${bucket}/${key.replace(/^\/+/, '')}`,
          '--pipe',
          '--content-type',
          contentType,
          '--remote',
        ],
        buf,
      );
    },
    async get(key) {
      const out = runWrangler(
        ['object', 'get', `${bucket}/${key.replace(/^\/+/, '')}`, '--pipe', '--remote'],
        Buffer.alloc(0),
      );
      return Buffer.isBuffer(out) ? out : Buffer.from(String(out));
    },
    async list(prefix = '') {
      const token = readWranglerAuth();
      if (!token || !accountId) return [];
      const keys = [];
      let cursor = undefined;
      for (;;) {
        const u = new URL(
          `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}/r2/buckets/${encodeURIComponent(bucket)}/objects`,
        );
        if (prefix) u.searchParams.set('prefix', prefix);
        if (cursor) u.searchParams.set('cursor', cursor);
        const res = await fetchImpl(u.toString(), {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`Cloudflare R2 list ${bucket} → HTTP ${res.status}`);
        const body = await res.json();
        for (const obj of body.result ?? []) {
          if (typeof obj?.key === 'string') keys.push(obj.key);
        }
        const nextCursor = body.result_info?.cursor;
        if (!body.result_info?.is_truncated || !nextCursor) break;
        cursor = nextCursor;
      }
      return keys;
    },
    async delete(key) {
      runWrangler(['object', 'delete', `${bucket}/${key.replace(/^\/+/, '')}`, '--remote']);
    },
  };
}
export function createR2Store({
  accountId,
  bucket,
  accessKeyId,
  secretAccessKey,
  endpoint,
  fetchImpl = fetch,
}) {
  const base = (endpoint ?? `https://${accountId}.r2.cloudflarestorage.com`).replace(/\/+$/, '');
  const objectUrl = (key) => `${base}/${encodeURIComponent(bucket)}/${key.replace(/^\/+/, '')}`;

  return {
    async put(key, body, contentType = 'application/octet-stream') {
      const url = objectUrl(key);
      const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
      const headers = signR2Request({
        method: 'PUT',
        url,
        accessKeyId,
        secretAccessKey,
        body: buf,
        contentType,
      });
      const res = await fetchImpl(url, { method: 'PUT', headers, body: buf });
      if (!res.ok) throw new Error(`R2 PUT ${key} → HTTP ${res.status}`);
    },
    async get(key) {
      const url = objectUrl(key);
      const headers = signR2Request({ method: 'GET', url, accessKeyId, secretAccessKey });
      const res = await fetchImpl(url, { method: 'GET', headers });
      if (!res.ok) throw new Error(`R2 GET ${key} → HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    },
    async list(prefix = '') {
      const keys = [];
      let token = undefined;
      for (;;) {
        const u = new URL(`${base}/${encodeURIComponent(bucket)}`);
        u.searchParams.set('list-type', '2');
        if (prefix) u.searchParams.set('prefix', prefix);
        if (token) u.searchParams.set('continuation-token', token);
        const url = u.toString();
        const headers = signR2Request({ method: 'GET', url, accessKeyId, secretAccessKey });
        const res = await fetchImpl(url, { method: 'GET', headers });
        if (!res.ok) throw new Error(`R2 LIST ${prefix} → HTTP ${res.status}`);
        const xml = await res.text();
        for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g)) {
          keys.push(m[1]);
        }
        const trunc = /<IsTruncated>true<\/IsTruncated>/.test(xml);
        const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml)?.[1];
        if (!trunc || !next) break;
        token = next;
      }
      return keys;
    },
    async delete(key) {
      const url = objectUrl(key);
      const headers = signR2Request({ method: 'DELETE', url, accessKeyId, secretAccessKey });
      const res = await fetchImpl(url, { method: 'DELETE', headers });
      if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE ${key} → HTTP ${res.status}`);
    },
  };
}

/**
 * Run one full backup pass over `mainClient`, `traceClient`, and optional `consoleClient`,
 * uploading encrypted blobs to `store` and pruning expired objects.
 */
export async function runBackupPass({
  mainClient,
  traceClient,
  consoleClient = null,
  store,
  encryptionKey,
  date = new Date().toISOString().slice(0, 10),
  now = Date.now(),
  dryRun = false,
}) {
  const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : parseBackupKey(encryptionKey);
  const { rows: teams } = await mainClient.query(
    'SELECT * FROM teams WHERE archived_at IS NULL ORDER BY slug ASC',
  );
  const uploaded = [];
  for (const team of teams) {
    const coordKey = `teams/${team.slug}/coordination/${date}.json.gz.enc`;
    const coordSnap = await exportTeamCoordination(mainClient, team, now);
    const coordEnc = encryptDump(JSON.stringify(coordSnap), key, coordKey);
    if (!dryRun) await store.put(coordKey, coordEnc);
    uploaded.push({ key: coordKey, bytes: coordEnc.length, kind: 'coordination', team: team.slug });

    const traceKey = `teams/${team.slug}/trace/${date}.json.gz.enc`;
    const traceSnap = await exportTeamTrace(traceClient, team, now);
    const traceEnc = encryptDump(JSON.stringify(traceSnap), key, traceKey);
    if (!dryRun) await store.put(traceKey, traceEnc);
    uploaded.push({ key: traceKey, bytes: traceEnc.length, kind: 'trace', team: team.slug });
  }

  if (consoleClient) {
    const consoleKey = `console/${date}.json.gz.enc`;
    const consoleSnap = await exportConsoleSnapshot(consoleClient, now);
    const consoleEnc = encryptDump(JSON.stringify(consoleSnap), key, consoleKey);
    if (!dryRun) await store.put(consoleKey, consoleEnc);
    uploaded.push({ key: consoleKey, bytes: consoleEnc.length, kind: 'console', team: null });
  }

  const pruned = [];
  if (!dryRun) {
    const existing = await store.list();
    for (const oldKey of expiredBackupKeys(existing, date)) {
      await store.delete(oldKey);
      pruned.push(oldKey);
    }
  }

  return { date, teams: teams.length, uploaded, pruned };
}

/* ────────────────────── CLI entrypoint ────────────────────── */

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

/** Build the macOS LaunchAgent plist for the nightly unattended R2 backup (`03:17` local). */
export function buildBackupLaunchdPlist({
  nodePath = process.execPath,
  repoRoot = fileURLToPath(new URL('../..', import.meta.url)),
  logPath = join(homedir(), '.musterd', 'cloud', 'backup.log'),
  hour = 3,
  minute = 17,
} = {}) {
  const scriptPath = join(repoRoot, 'scripts', 'cloud', 'backup.mjs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>studio.sandrise.musterd-cloud-backup</string>
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
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${dirname(nodePath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
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
  const args = process.argv.slice(2);
  const defaultKeyPath = join(homedir(), '.musterd', 'cloud', 'backup.key');
  const defaultNeonEnvPath = join(homedir(), '.musterd', 'cloud', 'neon.env');

  if (args.includes('--install-launchd')) {
    const plistDir = join(homedir(), 'Library', 'LaunchAgents');
    const plistPath = join(plistDir, 'studio.sandrise.musterd-cloud-backup.plist');
    const logPath = join(homedir(), '.musterd', 'cloud', 'backup.log');
    const runtimeRoot = join(homedir(), '.musterd', 'runtime');
    const repoRoot = existsSync(join(runtimeRoot, 'scripts', 'cloud', 'backup.mjs'))
      ? runtimeRoot
      : fileURLToPath(new URL('../..', import.meta.url));
    mkdirSync(plistDir, { recursive: true });
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
    writeFileSync(plistPath, buildBackupLaunchdPlist({ repoRoot, logPath }), { mode: 0o644 });
    spawnSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    const load = spawnSync('launchctl', ['load', plistPath], { encoding: 'utf8' });
    if (load.status !== 0) {
      throw new Error(`launchctl load failed (exit ${load.status}): ${load.stderr ?? ''}`);
    }
    if (args.includes('--kickstart')) {
      const uid = process.getuid ? process.getuid() : 501;
      const ks = spawnSync(
        'launchctl',
        ['kickstart', '-k', `gui/${uid}/studio.sandrise.musterd-cloud-backup`],
        { encoding: 'utf8' },
      );
      if (ks.status !== 0) {
        throw new Error(`launchctl kickstart failed (exit ${ks.status}): ${ks.stderr ?? ''}`);
      }
    }
    console.log(
      JSON.stringify({
        msg: 'cloud_backup_schedule_installed',
        label: 'studio.sandrise.musterd-cloud-backup',
        plist: plistPath,
        log: logPath,
        schedule: '03:17 daily',
      }),
    );
    return;
  }

  if (args.includes('--keygen')) {
    if (existsSync(defaultKeyPath) && !args.includes('--force')) {
      throw new Error(`${defaultKeyPath} already exists (pass --force to overwrite)`);
    }
    mkdirSync(dirname(defaultKeyPath), { recursive: true, mode: 0o700 });
    const generated = randomBytes(32).toString('hex');
    writeFileSync(defaultKeyPath, `${generated}\n`, { mode: 0o600 });
    console.log(`wrote 32-byte backup key to ${defaultKeyPath} (mode 600)`);
    return;
  }

  const dryRun = args.includes('--dry-run');
  const rawKey =
    process.env.MUSTERD_BACKUP_KEY?.trim() ||
    (existsSync(defaultKeyPath) ? readKeyFile(defaultKeyPath) : '');
  if (!rawKey) {
    throw new Error(
      `backup key required: set MUSTERD_BACKUP_KEY or run 'node scripts/cloud/backup.mjs --keygen'`,
    );
  }
  const encryptionKey = parseBackupKey(rawKey);

  const fileEnv = readEnvFile(defaultNeonEnvPath);
  const mainUrl =
    process.env.MUSTERD_DATABASE_OWNER_URL ??
    process.env.MUSTERD_DATABASE_OPERATOR_URL ??
    fileEnv.MUSTERD_DATABASE_OWNER_URL ??
    fileEnv.DATABASE_OWNER_URL ??
    fileEnv.MUSTERD_DATABASE_OPERATOR_URL ??
    fileEnv.DATABASE_OPERATOR_URL;
  const deriveTraceUrl = (url) => {
    if (!url) return undefined;
    const u = new URL(url);
    u.pathname = `${u.pathname}_trace`;
    return u.toString();
  };
  const traceUrl =
    process.env.MUSTERD_TRACE_DATABASE_OWNER_URL ??
    process.env.MUSTERD_TRACE_DATABASE_OPERATOR_URL ??
    fileEnv.MUSTERD_TRACE_DATABASE_OWNER_URL ??
    fileEnv.TRACE_DATABASE_OWNER_URL ??
    deriveTraceUrl(mainUrl);
  if (!mainUrl || !traceUrl) {
    throw new Error(
      'backup requires MUSTERD_DATABASE_OWNER_URL (or _OPERATOR_URL) and MUSTERD_TRACE_DATABASE_OWNER_URL (or _OPERATOR_URL)',
    );
  }

  let store = null;
  if (!dryRun) {
    const accountId = process.env.MUSTERD_BACKUP_R2_ACCOUNT_ID?.trim();
    const bucket = process.env.MUSTERD_BACKUP_R2_BUCKET?.trim() || 'musterd-cloud-backups';
    const accessKeyId = process.env.MUSTERD_BACKUP_R2_ACCESS_KEY_ID?.trim();
    const secretAccessKey = process.env.MUSTERD_BACKUP_R2_SECRET_ACCESS_KEY?.trim();
    if (accountId && accessKeyId && secretAccessKey) {
      store = createR2Store({
        accountId,
        bucket,
        accessKeyId,
        secretAccessKey,
        endpoint: process.env.MUSTERD_BACKUP_R2_ENDPOINT?.trim() || undefined,
      });
    } else if (args.includes('--wrangler')) {
      store = createWranglerR2Store({ bucket });
    } else {
      throw new Error(
        'R2 upload requires MUSTERD_BACKUP_R2_ACCOUNT_ID, MUSTERD_BACKUP_R2_ACCESS_KEY_ID, and MUSTERD_BACKUP_R2_SECRET_ACCESS_KEY (or pass --wrangler or --dry-run)',
      );
    }
  }

  const pg = createRequire(new URL('../../packages/server/package.json', import.meta.url))('pg');
  const mainClient = new pg.Client({ connectionString: mainUrl });
  const traceClient = new pg.Client({ connectionString: traceUrl });
  const consoleUrl = process.env.MUSTERD_CONSOLE_DATABASE_OWNER_URL?.trim();
  const consoleClient = consoleUrl ? new pg.Client({ connectionString: consoleUrl }) : null;

  await mainClient.connect();
  await traceClient.connect();
  if (consoleClient) await consoleClient.connect();
  try {
    const date = process.env.MUSTERD_BACKUP_DATE?.trim() || new Date().toISOString().slice(0, 10);
    const result = await runBackupPass({
      mainClient,
      traceClient,
      consoleClient,
      store,
      encryptionKey,
      date,
      dryRun,
    });

    if (process.env.MUSTERD_BACKUP_PG_DUMP === '1') {
      for (const [kind, dbUrl] of [
        ['coordination', mainUrl],
        ['trace', traceUrl],
      ]) {
        const dump = spawnSync('pg_dump', ['--format=custom', '--no-owner', '--no-acl', dbUrl], {
          maxBuffer: 256 * 1024 * 1024,
        });
        if (dump.status !== 0) {
          throw new Error(`pg_dump (${kind}) exited ${dump.status}`);
        }
        const dumpKey = `pg_dump/${kind}/${date}.dump.enc`;
        const enc = encryptDump(dump.stdout, encryptionKey, dumpKey);
        if (!dryRun) await store.put(dumpKey, enc);
        result.uploaded.push({
          key: dumpKey,
          bytes: enc.length,
          kind: `pg_dump_${kind}`,
          team: null,
        });
      }
    }

    console.log(
      JSON.stringify({
        msg: 'cloud_backup_completed',
        date: result.date,
        dry_run: dryRun,
        teams: result.teams,
        uploaded: result.uploaded.length,
        total_bytes: result.uploaded.reduce((s, u) => s + u.bytes, 0),
        pruned: result.pruned.length,
      }),
    );
  } finally {
    await mainClient.end().catch(() => {});
    await traceClient.end().catch(() => {});
    if (consoleClient) await consoleClient.end().catch(() => {});
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error(
      `backup failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`,
    );
    process.exit(1);
  });
}
