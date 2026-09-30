// The `/report` derivation, run off the event loop (lane 01M3D4069F). `deriveReport` costs 1-3 s of
// synchronous SQLite on a production-sized board; on the daemon's single loop that stalled every other
// request for the duration, and 50 polling viewers stacked it into 13 s p95s across all routes. This
// worker holds its own READ-ONLY connection — WAL lets it read beside the daemon's writer — and derives
// on request. The report is a pure read (verified read-only against a live copy), so nothing here writes.
import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { sqliteDriver } from '../db/sqliteDriver.js';
import { deriveReport } from './insights.js';

export interface ReportJob {
  id: number;
  teamId: string;
  teamSlug: string;
  now: number;
  presenceTimeoutMs: number;
}

export type ReportReply =
  | { id: number; ok: true; report: unknown }
  | { id: number; ok: false; error: string };

const { dbPath } = workerData as { dbPath: string };
const raw = new Database(dbPath, { readonly: true, fileMustExist: true });
raw.pragma('busy_timeout = 5000');
const db = sqliteDriver(raw);

parentPort!.on('message', async (job: ReportJob) => {
  let reply: ReportReply;
  try {
    const report = await deriveReport(db, job.teamId, job.teamSlug, job.now, job.presenceTimeoutMs);
    reply = { id: job.id, ok: true, report };
  } catch (err) {
    reply = { id: job.id, ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  parentPort!.postMessage(reply);
});
