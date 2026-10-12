// `/health`'s store sizes, off the event loop (lane 01M4RNPQD0). `storeSizes` walks every sync_log
// page through `dbstat` — synchronous SQLite, measured on the hub 2026-10-12 at 0.8 s warm and 15 s
// cold — and `/health` is the probe the guardian, the auto-refresher and every CLI guard poll for
// liveness. So the liveness probe was itself wedging the daemon it was asked about: /health timed
// out at 5 s while every logged handler was fast. The sizes are a growth signal (ADR 478
// §Observability), not a liveness one, so `/health` serves the last measurement and refreshes it in a
// worker thread on its own read-only connection at most every STORE_SIZES_TTL_MS.
import { Worker } from 'node:worker_threads';
import type { Driver } from '../db/driver.js';
import type { SqliteDriver } from '../db/sqliteDriver.js';
import { type StoreSizes, storeSizes } from './retention.js';

export const STORE_SIZES_TTL_MS = 10 * 60_000;

export type MeasureStoreSizes = (dbPath: string, archiveDir: string | null) => Promise<StoreSizes>;

interface State {
  value: StoreSizes | undefined;
  /** When the last measurement settled; null until one has been attempted. */
  at: number | null;
  inflight: Promise<void> | null;
}

const states = new WeakMap<Driver, State>();

/**
 * The sizes `/health` reports. A file-backed SQLite store answers from the last measurement — the
 * first call answers with everything but `sync_log_bytes` (absent, never zero, when unknown), which
 * is computed inline because none of it walks pages — and kicks one background refresh when the
 * measurement is older than the TTL. Postgres (async I/O) and in-memory stores measure inline, as
 * before. `opts.measure` replaces the worker (tests); it applies whatever the store.
 */
export async function healthStoreSizes(
  db: Driver,
  dbPath: string,
  archiveDir: string | null,
  opts: { measure?: MeasureStoreSizes; now?: () => number; ttlMs?: number } = {},
): Promise<StoreSizes> {
  const fileBacked =
    db.dialect === 'sqlite' && dbPath !== ':memory:' && !(db as SqliteDriver).raw?.memory;
  if (!opts.measure && !fileBacked) return await storeSizes(db, dbPath, archiveDir);
  const now = opts.now ?? Date.now;
  const ttl = opts.ttlMs ?? STORE_SIZES_TTL_MS;
  const measure = opts.measure ?? measureInWorker;
  let state = states.get(db);
  if (!state) states.set(db, (state = { value: undefined, at: null, inflight: null }));
  if (state.value === undefined) {
    state.value = await storeSizes(db, dbPath, archiveDir, { bytes: false });
  }
  if ((state.at === null || now() - state.at >= ttl) && state.inflight === null) {
    const s = state;
    s.inflight = measure(dbPath, archiveDir)
      .then((v) => {
        s.value = v;
      })
      // A failed measurement keeps the last value and waits out a TTL before trying again.
      .catch(() => undefined)
      .finally(() => {
        s.at = now();
        s.inflight = null;
      });
  }
  return state.value;
}

/** One short-lived worker per refresh: at a 10-minute cadence a thread start costs nothing. */
const measureInWorker: MeasureStoreSizes = (dbPath, archiveDir) =>
  new Promise<StoreSizes>((resolve, reject) => {
    const worker = new Worker(new URL('./storeSizesWorker.js', import.meta.url), {
      workerData: { dbPath, archiveDir },
    });
    worker.unref(); // never the reason the daemon stays alive
    worker.once(
      'message',
      (reply: { ok: true; sizes: StoreSizes } | { ok: false; error: string }) =>
        reply.ok ? resolve(reply.sizes) : reject(new Error(reply.error)),
    );
    worker.once('error', reject);
    worker.once('exit', (code) => reject(new Error(`store sizes worker exited (${code})`)));
  });
