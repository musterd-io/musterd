// `/health`'s store-size measurement, run off the event loop (see storeSizesHealth.ts). It opens its
// own READ-ONLY connection — WAL lets it read beside the daemon's writer — measures once, and exits.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { sqliteDriver } from '../db/sqliteDriver.js';
import { storeSizes } from './retention.js';

const { dbPath, archiveDir } = workerData as { dbPath: string; archiveDir: string | null };

try {
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  raw.pragma('busy_timeout = 5000');
  try {
    const sizes = await storeSizes(sqliteDriver(raw), dbPath, archiveDir);
    parentPort!.postMessage({ ok: true, sizes });
  } finally {
    raw.close();
  }
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
