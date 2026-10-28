// The heavy read behind `pruneAuditChurn` (ADR 478): finding the prunable churn rows needs a
// full scan of `audit` (329k rows on the hub) and blocks the event loop for ~1.2 s on a cold
// cache. Run it on a worker thread with its own read-only connection, the way storeSizes does, so
// the daemon's loop keeps serving while the scan runs. The worker returns the row ids; the caller
// does the archive + delete on its own connection afterwards.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { prunableSql } from './retention.js';

const { dbPath, floors, cutoff, limit } = workerData as {
  dbPath: string;
  floors: [string, number][];
  cutoff: number;
  limit: number;
};

try {
  const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
  raw.pragma('busy_timeout = 5000');
  try {
    const sql = `${prunableSql(floors.length)} LIMIT ?`;
    const params = [cutoff, ...floors.flat(), limit];
    const rows = raw.prepare(sql).all(...params);
    parentPort!.postMessage({ ok: true, rows });
  } finally {
    raw.close();
  }
} catch (err) {
  parentPort!.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
}
