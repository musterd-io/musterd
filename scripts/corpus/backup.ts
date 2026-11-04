/**
 * One-command corpus backup (ADR 798): take a snapshot, upload it to the private off-machine
 * bucket, verify by size, and stamp `~/.musterd/corpus-backups/LAST.json`. The weekly launchd
 * job runs exactly this; a human can run it any time with `pnpm corpus:backup`.
 *
 * Fails closed: no credentials, a failed snapshot, or a size mismatch exits non-zero and leaves
 * LAST.json untouched, so `pnpm corpus:check` goes stale loudly instead of silently.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveCredentials, uploadLastMarker, uploadSnapshot } from './upload.ts';

const here = dirname(fileURLToPath(import.meta.url));

export function snapshotDirFromOutput(output: string): string | null {
  const lines = output.trim().split('\n');
  for (const line of lines) {
    const t = line.trim();
    if (/corpus-snapshots\/\d{4}-/.test(t) && t.startsWith('/')) return t;
  }
  return null;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const creds = resolveCredentials();
  if (!creds) {
    console.error(
      'no backup credentials: set CORPUS_BACKUP_URL + CORPUS_BACKUP_SERVICE_KEY or ~/.musterd/corpus-backup.env',
    );
    process.exit(1);
  }
  const out = execFileSync(
    'node',
    ['--disable-warning=ExperimentalWarning', join(here, 'snapshot.ts')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  process.stdout.write(out);
  const dir = snapshotDirFromOutput(out);
  if (!dir) {
    console.error('could not read the snapshot directory from snapshot.ts output');
    process.exit(1);
  }
  const result = await uploadSnapshot(dir, creds);
  const marker = {
    uploaded_at: new Date().toISOString(),
    snapshot: result.stamp,
    files: result.files,
    bytes: result.bytes,
    bucket: 'corpus-backups',
    prefix: `research-corpus/${result.stamp}/`,
    verified: 'remote size per file equals local size; MANIFEST.json uploaded last',
  };
  const lastDir = join(homedir(), '.musterd', 'corpus-backups');
  mkdirSync(lastDir, { recursive: true });
  writeFileSync(join(lastDir, 'LAST.json'), JSON.stringify(marker, null, 2) + '\n');
  await uploadLastMarker(creds, marker);
  console.log(
    `corpus backup complete: ${result.stamp} (${result.files} files, ${(result.bytes / 1048576).toFixed(1)} MB), verified off-machine`,
  );
}
