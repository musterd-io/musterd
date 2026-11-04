/**
 * Upload one corpus snapshot directory to the PRIVATE off-machine bucket nick named on
 * 2026-09-05 (Supabase project `exn-corpus-backup`, bucket `corpus-backups`). This is a backup
 * of the raw corpus, never a publication: the archive contains agent prose (ADR 184) and the
 * bucket is private. ADR 798 supersedes ADR 280 decision 4's manual-only upload.
 *
 * Credentials, in order: CORPUS_BACKUP_URL + CORPUS_BACKUP_SERVICE_KEY in the environment or in
 * `~/.musterd/corpus-backup.env` (chmod 600, never in the repo). The service key is never printed.
 *
 * Files go up individually under `research-corpus/<snapshot>/`; `MANIFEST.json` goes last, so its
 * presence means the upload completed. Files over the standard-upload ceiling use Supabase's
 * resumable (TUS) endpoint with its required 6 MB chunks.
 *
 *   node scripts/corpus/upload.ts <snapshot-dir> [--dry-run]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

export const BUCKET = 'corpus-backups';
export const PREFIX = 'research-corpus';
/**
 * The bucket caps a single object at 50 MB (measured 2026-11-04: a 112 MB resumable create
 * answers 413). Artifacts over this size upload as `<name>.part-000`, `-001`, … slices;
 * restoring is `cat` in order. The snapshot's own MANIFEST.json sha256s the whole artifact.
 */
export const PART_BYTES = 40 * 1024 * 1024;

export interface RemotePart {
  /** Object name inside the snapshot prefix, e.g. `trace.db.db.gz.part-001`. */
  remoteName: string;
  offset: number;
  bytes: number;
}

export function partsFor(name: string, bytes: number): RemotePart[] {
  if (bytes <= PART_BYTES) return [{ remoteName: name, offset: 0, bytes }];
  const parts: RemotePart[] = [];
  for (let offset = 0, i = 0; offset < bytes; offset += PART_BYTES, i++) {
    parts.push({
      remoteName: `${name}.part-${String(i).padStart(3, '0')}`,
      offset,
      bytes: Math.min(PART_BYTES, bytes - offset),
    });
  }
  return parts;
}

export interface BackupCredentials {
  url: string;
  serviceKey: string;
}

export function parseEnvText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m?.[1]) out[m[1]] = (m[2] ?? '').replace(/^["']|["']$/g, '');
  }
  return out;
}

export function resolveCredentials(
  env: Record<string, string | undefined> = process.env,
  envFile: string = join(homedir(), '.musterd', 'corpus-backup.env'),
): BackupCredentials | null {
  const fromFile = existsSync(envFile) ? parseEnvText(readFileSync(envFile, 'utf8')) : {};
  const url = env['CORPUS_BACKUP_URL'] ?? fromFile['CORPUS_BACKUP_URL'];
  const serviceKey = env['CORPUS_BACKUP_SERVICE_KEY'] ?? fromFile['CORPUS_BACKUP_SERVICE_KEY'];
  if (!url || !serviceKey) return null;
  return { url: url.replace(/\/$/, ''), serviceKey };
}

export function plannedObjects(
  snapshotDir: string,
): { name: string; bytes: number; key: string }[] {
  const stamp = basename(snapshotDir);
  const names = readdirSync(snapshotDir).filter((n) => statSync(join(snapshotDir, n)).isFile());
  names.sort((a, b) =>
    a === 'MANIFEST.json' ? 1 : b === 'MANIFEST.json' ? -1 : a.localeCompare(b),
  );
  return names.map((name) => ({
    name,
    bytes: statSync(join(snapshotDir, name)).size,
    key: `${PREFIX}/${stamp}/${name}`,
  }));
}

function headers(
  creds: BackupCredentials,
  extra: Record<string, string> = {},
): Record<string, string> {
  return { apikey: creds.serviceKey, Authorization: `Bearer ${creds.serviceKey}`, ...extra };
}

async function uploadStandard(
  creds: BackupCredentials,
  key: string,
  path: string,
  range?: { offset: number; bytes: number },
): Promise<void> {
  let body = readFileSync(path);
  if (range) body = body.subarray(range.offset, range.offset + range.bytes);
  // No x-upsert: the storage insert's ON CONFLICT path answers 42P10 on this project.
  // Idempotency comes from uploadSnapshot skipping objects already present at the right size.
  const res = await fetch(`${creds.url}/storage/v1/object/${BUCKET}/${key}`, {
    method: 'POST',
    headers: headers(creds, { 'Content-Type': 'application/octet-stream' }),
    body,
  });
  if (!res.ok)
    throw new Error(`upload ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 160)}`);
}

async function listPrefix(creds: BackupCredentials, prefix: string): Promise<Map<string, number>> {
  const res = await fetch(`${creds.url}/storage/v1/object/list/${BUCKET}`, {
    method: 'POST',
    headers: headers(creds, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ prefix, limit: 1000 }),
  });
  if (!res.ok) throw new Error(`list ${prefix}: HTTP ${res.status}`);
  const rows = (await res.json()) as { name: string; metadata?: { size?: number } }[];
  return new Map(rows.map((r) => [r.name, r.metadata?.size ?? -1]));
}

export async function uploadSnapshot(
  snapshotDir: string,
  creds: BackupCredentials,
  log: (line: string) => void = console.log,
): Promise<{ stamp: string; files: number; bytes: number }> {
  const stamp = basename(snapshotDir);
  const objects = plannedObjects(snapshotDir);
  const already = await listPrefix(creds, `${PREFIX}/${stamp}`);
  let bytes = 0;
  for (const obj of objects) {
    const path = join(snapshotDir, obj.name);
    for (const part of partsFor(obj.name, obj.bytes)) {
      if (already.get(part.remoteName) === part.bytes) continue;
      await uploadStandard(creds, `${PREFIX}/${stamp}/${part.remoteName}`, path, part);
    }
    bytes += obj.bytes;
    log(`  uploaded ${obj.name} (${(obj.bytes / 1048576).toFixed(1)} MB)`);
  }
  const remote = await listPrefix(creds, `${PREFIX}/${stamp}`);
  for (const obj of objects) {
    for (const part of partsFor(obj.name, obj.bytes)) {
      const size = remote.get(part.remoteName);
      if (size !== part.bytes) {
        throw new Error(
          `verify ${part.remoteName}: remote size ${size ?? 'missing'} != local ${part.bytes}`,
        );
      }
    }
  }
  return { stamp, files: objects.length, bytes };
}

export async function uploadLastMarker(
  creds: BackupCredentials,
  marker: Record<string, unknown>,
): Promise<void> {
  const url = `${creds.url}/storage/v1/object/${BUCKET}/${PREFIX}/LAST.json`;
  const body = JSON.stringify(marker, null, 2);
  // PUT updates an existing marker; POST creates the first one. (x-upsert answers 42P10 here.)
  let res = await fetch(url, {
    method: 'PUT',
    headers: headers(creds, { 'Content-Type': 'application/json' }),
    body,
  });
  if (!res.ok) {
    res = await fetch(url, {
      method: 'POST',
      headers: headers(creds, { 'Content-Type': 'application/json' }),
      body,
    });
  }
  if (!res.ok) throw new Error(`upload LAST.json: HTTP ${res.status}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) {
    console.error('usage: upload.ts <snapshot-dir> [--dry-run]');
    process.exit(2);
  }
  if (process.argv.includes('--dry-run')) {
    for (const o of plannedObjects(dir)) console.log(`${o.key}  ${o.bytes}`);
    process.exit(0);
  }
  const creds = resolveCredentials();
  if (!creds) {
    console.error(
      'no backup credentials: set CORPUS_BACKUP_URL + CORPUS_BACKUP_SERVICE_KEY or ~/.musterd/corpus-backup.env',
    );
    process.exit(1);
  }
  const result = await uploadSnapshot(dir, creds);
  console.log(
    `uploaded ${result.files} files, ${(result.bytes / 1048576).toFixed(1)} MB -> ${BUCKET}/${PREFIX}/${result.stamp}/ (verified by size)`,
  );
}
