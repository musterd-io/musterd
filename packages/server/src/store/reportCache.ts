// `/report` serving (lane 01M3D4069F): a per-team single-flight cache in front of a derivation that
// runs in a worker thread. The 2026-09-28 demo-scale tunnel bench measured GET /report at p95 13 s and
// dragged every other route's p95 to 1-4 s: each of 50 viewers' polls ran the full 1-3 s derivation
// synchronously on the daemon's one event loop. Two fixes, one module:
//
//  - **Single flight + short TTL.** Every viewer of a team gets the same report, so one derivation
//    serves them all for REPORT_TTL_MS; a poll that lands mid-derivation joins it. Past the TTL a
//    reader gets the last report at once while one refresh runs (stale-while-revalidate) — `generated_ts`
//    already tells the reader its age. Past REPORT_MAX_STALE_MS the reader waits for the fresh one.
//  - **Off the loop.** A file-backed daemon derives in `reportWorker` on its own read-only WAL
//    connection. An in-memory store (tests, ephemeral daemons) cannot be shared with a worker, so it
//    derives inline and uncached — exactly the pre-fix behavior, which its tests assert on.
//  - **Cloud** (lane 01M3ZCTQ77) derives inline — Postgres I/O is async, so the loop stays free —
//    behind the same cache, under the requesting team's scoped handle (`scope`), so RLS holds. The
//    service is keyed by the server's ROOT store: Postgres mints a fresh team handle per request, and
//    a cache keyed by that handle was a cache per request (the 2026-10-03 load run: 1 346 derivations).
import { Worker } from 'node:worker_threads';
import type { Report } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import type { SqliteDriver } from '../db/sqliteDriver.js';
import { deriveReport } from './insights.js';
import type { ReportJob, ReportReply } from './reportWorker.js';

export const REPORT_TTL_MS = 5_000;
export const REPORT_MAX_STALE_MS = 60_000;

/** `scope` is the request's team-scoped handle; only an inline derive reads it. */
type Derive = (teamId: string, teamSlug: string, now: number, scope?: Driver) => Promise<Report>;

interface Entry {
  report?: Report;
  at: number;
  inflight?: Promise<Report> | undefined;
}

/** The cache policy, separated from the worker so it is testable with a fake `derive`. */
export function createReportCache(
  derive: Derive,
  opts: { ttlMs?: number; maxStaleMs?: number; now?: () => number } = {},
) {
  const ttl = opts.ttlMs ?? REPORT_TTL_MS;
  const maxStale = opts.maxStaleMs ?? REPORT_MAX_STALE_MS;
  const clock = opts.now ?? Date.now;
  const entries = new Map<string, Entry>();

  function refresh(
    teamId: string,
    teamSlug: string,
    entry: Entry,
    scope: Driver | undefined,
  ): Promise<Report> {
    if (entry.inflight) return entry.inflight;
    const started = clock();
    entry.inflight = derive(teamId, teamSlug, started, scope).then(
      (report) => {
        entry.report = report;
        entry.at = started;
        entry.inflight = undefined;
        return report;
      },
      (err: unknown) => {
        entry.inflight = undefined;
        throw err;
      },
    );
    return entry.inflight;
  }

  return {
    async get(teamId: string, teamSlug: string, scope?: Driver): Promise<Report> {
      let entry = entries.get(teamId);
      if (!entry) {
        entry = { at: 0 };
        entries.set(teamId, entry);
      }
      const age = clock() - entry.at;
      if (entry.report && age < ttl) return Promise.resolve(entry.report);
      if (entry.report && age < maxStale) {
        // Serve stale now; a failed background refresh is retried by the next reader.
        refresh(teamId, teamSlug, entry, scope).catch(() => {});
        return Promise.resolve(entry.report);
      }
      return refresh(teamId, teamSlug, entry, scope);
    },
  };
}

/** One worker per daemon, lazily started, holding a read-only connection to `dbPath`. */
class ReportWorker {
  private worker: Worker | undefined;
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: Report) => void; reject: (e: Error) => void }>();

  constructor(private readonly dbPath: string) {}

  derive(job: Omit<ReportJob, 'id'>): Promise<Report> {
    const worker = this.ensure();
    const id = this.nextId++;
    return new Promise<Report>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ ...job, id } satisfies ReportJob);
    });
  }

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./reportWorker.js', import.meta.url), {
      workerData: { dbPath: this.dbPath },
    });
    worker.unref(); // never the reason the daemon stays alive
    worker.on('message', (reply: ReportReply) => {
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      if (reply.ok) p.resolve(reply.report as Report);
      else p.reject(new Error(reply.error));
    });
    const fail = (err: Error) => {
      // A dead worker fails its in-flight jobs; the next derive starts a fresh one.
      this.worker = undefined;
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    };
    worker.on('error', fail);
    worker.on('exit', (code) => fail(new Error(`report worker exited (${code})`)));
    this.worker = worker;
    return worker;
  }

  async close(): Promise<void> {
    const w = this.worker;
    this.worker = undefined;
    if (w) await w.terminate();
  }
}

export interface ReportService {
  /** `scope`: the request's team-scoped handle. An inline derive runs under it; the worker ignores it. */
  get(teamId: string, teamSlug: string, scope?: Driver): Promise<Report>;
  close(): Promise<void>;
}

export interface ReportServiceOptions {
  /** Cache an inline derive (Cloud). Off, an inline store derives fresh on every read. */
  cacheInline?: boolean;
}

export function createReportService(
  db: Driver,
  presenceTimeoutMs: number,
  opts: ReportServiceOptions = {},
): ReportService {
  // The worker opens the store by path, so only a file-backed SQLite store gets one; an in-memory
  // store (and any other dialect) derives inline.
  const file =
    db.dialect === 'sqlite' && !(db as SqliteDriver).raw.memory
      ? (db as SqliteDriver).raw.name
      : null;
  if (file === null) {
    const derive: Derive = (teamId, teamSlug, now, scope) =>
      deriveReport(scope ?? db, teamId, teamSlug, now, presenceTimeoutMs);
    if (!opts.cacheInline)
      return {
        get: (teamId, teamSlug, scope) => derive(teamId, teamSlug, Date.now(), scope),
        close: () => Promise.resolve(),
      };
    // Cloud derives in ONE transaction (lane 01M46RPQ94): one pool checkout and one consistent
    // snapshot, not a BEGIN/COMMIT per statement. Load run 12 (2026-10-05) measured a derivation at
    // 202 transactions, ~250 ms each under load; a refresh outlasted REPORT_MAX_STALE_MS and every
    // viewer's poll queued behind it.
    const cache = createReportCache((teamId, teamSlug, now, scope) =>
      (scope ?? db).tx((t) => deriveReport(t, teamId, teamSlug, now, presenceTimeoutMs)),
    );
    return {
      get: (teamId, teamSlug, scope) => cache.get(teamId, teamSlug, scope),
      close: () => Promise.resolve(),
    };
  }
  const worker = new ReportWorker(file);
  const cache = createReportCache((teamId, teamSlug, now) =>
    worker.derive({ teamId, teamSlug, now, presenceTimeoutMs }),
  );
  return { get: (teamId, teamSlug) => cache.get(teamId, teamSlug), close: () => worker.close() };
}

// One service per store, created on first use, so callers that build a `Ctx` by hand need no wiring.
const services = new WeakMap<Driver, ReportService>();

export function reportServiceFor(
  db: Driver,
  presenceTimeoutMs: number,
  opts: ReportServiceOptions = {},
): ReportService {
  let s = services.get(db);
  if (!s) {
    s = createReportService(db, presenceTimeoutMs, opts);
    services.set(db, s);
  }
  return s;
}

export async function closeReportService(db: Driver): Promise<void> {
  const s = services.get(db);
  services.delete(db);
  if (s) await s.close();
}
