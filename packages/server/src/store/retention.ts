/**
 * Local store retention (ADR 478): the churn class of `audit` is archived and pruned past its
 * window; everything else in `audit` is kept. `sync_log` is deliberately NOT touched here (ADR 478
 * §Decision 2 — the hub records no peer's pull position and a joiner folds from `hub_seq` 0), and
 * trace content has its own prune in `trace.ts` (ADR 445; window shortened by ADR 478 §3).
 *
 * Shape borrowed from `pruneTraceContent`: a pass is bounded batches, each its own short
 * transaction, gated by the corpus watermark `corpus:snapshot` stamps so an archiving machine never
 * deletes the only copy of a row the corpus has not captured.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type Database from 'better-sqlite3';
import type { AuditAction, AuditRow } from './audit.js';

/**
 * The churn class — lifecycle rows a seat writes many times a day and nothing reads back past a
 * window. Extended only by editing this list; `auditReadersOfChurnActions` pins who reads it.
 */
export const AUDIT_CHURN_ACTIONS: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'presence.attached',
  'presence.detached',
  'presence.reattested',
  'bootstrap_credential.used',
  'agent_session_lease.minted',
  'agent_session_lease.renewed',
  'claim.occupied',
  'claim.superseded',
  'claim.duplicate_workspace',
  'claim.reseated',
  'occupancy.model_attested',
  'mcp.surface_rendered',
  'continuity.cursor_advanced',
  'record.tool_calls',
]);

/** Churn actions a daemon query reads as "newest row per seat, unbounded" — that row is kept. */
const LATEST_PER_SEAT: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'occupancy.model_attested',
  'mcp.surface_rendered',
]);

/** How long churn stays in the live store (ADR 478 §1). */
export const AUDIT_CHURN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Rows per prune transaction, and transactions per pass — same reasoning as the trace prune. */
export const AUDIT_PRUNE_BATCH = 5_000;
export const AUDIT_PRUNE_MAX_BATCHES = 20;

/** `schema_meta` key `corpus:snapshot` stamps on the coordination store: `MAX(ts)` of the captured
 *  `audit`. `scripts/corpus/snapshot.ts` carries its own copy; the test pins that they agree. */
export const AUDIT_CAPTURED_THROUGH_KEY = 'audit_captured_through';

/** The capture watermark, or null on a machine that never archived. */
export function auditCapturedThrough(db: Database.Database): number | null {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM schema_meta WHERE key = ?')
    .get(AUDIT_CAPTURED_THROUGH_KEY);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** `~/.musterd/archive` beside the store; null for an in-memory store (nothing to archive to). */
export function defaultArchiveDir(dbPath: string): string | null {
  return dbPath === ':memory:' ? null : join(dirname(dbPath), 'archive');
}

export interface AuditPruneResult {
  pruned: number;
  archivedBytes: number;
  cutoff: number;
  capturedThrough: number | null;
  /** Rows pruned per team — the caller writes one `store.pruned` audit row each. */
  perTeam: Record<string, number>;
  skipped?: 'no_archive_dir';
}

const churnList = () => [...AUDIT_CHURN_ACTIONS].map((a) => `'${a}'`).join(', ');
const latestList = () => [...LATEST_PER_SEAT].map((a) => `'${a}'`).join(', ');

/**
 * Archive-then-prune one pass of churn rows older than the window and below the watermark.
 *
 * Kept whatever their age (ADR 478 §1): for each `origin_node` the row holding `MAX(origin_seq)`
 * (`sync/fold.ts` reads it as the peer's high-water mark), and for the latest-per-seat actions the
 * newest row per `(team, target)`. Each batch is gzipped and appended to
 * `<archiveDir>/audit-YYYY-MM.jsonl.gz` (one gzip member per batch — `gunzip` reads them all)
 * BEFORE the delete runs; a failed archive write throws and deletes nothing.
 */
export function pruneAuditChurn(
  db: Database.Database,
  opts: {
    now?: number;
    maxAgeMs?: number;
    batch?: number;
    maxBatches?: number;
    archiveDir: string | null;
  },
): AuditPruneResult {
  const now = opts.now ?? Date.now();
  const windowCutoff = now - (opts.maxAgeMs ?? AUDIT_CHURN_MAX_AGE_MS);
  const capturedThrough = auditCapturedThrough(db);
  const cutoff = capturedThrough === null ? windowCutoff : Math.min(windowCutoff, capturedThrough);
  const perTeam: Record<string, number> = {};
  if (opts.archiveDir === null) {
    return {
      pruned: 0,
      archivedBytes: 0,
      cutoff,
      capturedThrough,
      perTeam,
      skipped: 'no_archive_dir',
    };
  }
  const batch = opts.batch ?? AUDIT_PRUNE_BATCH;
  const maxBatches = opts.maxBatches ?? AUDIT_PRUNE_MAX_BATCHES;
  const select = db.prepare<[number, number], AuditRow>(`
    SELECT a.* FROM audit a
     WHERE a.action IN (${churnList()})
       AND a.ts < ?
       AND NOT (a.origin_seq > 0 AND a.origin_seq =
                (SELECT MAX(b.origin_seq) FROM audit b WHERE b.origin_node = a.origin_node))
       AND NOT (a.action IN (${latestList()}) AND a.id =
                (SELECT c.id FROM audit c
                  WHERE c.team_id = a.team_id AND c.action = a.action AND c.target IS a.target
                  ORDER BY c.ts DESC, c.id DESC LIMIT 1))
     ORDER BY a.ts, a.id
     LIMIT ?
  `);
  const del = db.prepare<[string]>('DELETE FROM audit WHERE id = ?');
  const deleteAll = db.transaction((ids: string[]) => {
    for (const id of ids) del.run(id);
  });
  let pruned = 0;
  let archivedBytes = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = select.all(cutoff, batch);
    if (rows.length === 0) break;
    archivedBytes += archiveRows(opts.archiveDir, rows);
    deleteAll(rows.map((r) => r.id));
    for (const r of rows) perTeam[r.team_id] = (perTeam[r.team_id] ?? 0) + 1;
    pruned += rows.length;
    if (rows.length < batch) break;
  }
  return { pruned, archivedBytes, cutoff, capturedThrough, perTeam };
}

/** Append the rows, grouped by the month of their `ts`, as one gzip member per file. */
function archiveRows(dir: string, rows: AuditRow[]): number {
  mkdirSync(dir, { recursive: true });
  const byMonth = new Map<string, string[]>();
  for (const r of rows) {
    const d = new Date(r.ts);
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    const lines = byMonth.get(key) ?? [];
    lines.push(JSON.stringify(r));
    byMonth.set(key, lines);
  }
  let bytes = 0;
  for (const [month, lines] of byMonth) {
    const member = gzipSync(`${lines.join('\n')}\n`);
    appendFileSync(join(dir, `audit-${month}.jsonl.gz`), member);
    bytes += member.byteLength;
  }
  return bytes;
}

/** How often the daemon runs {@link pruneAuditChurn}, and how long after boot the first pass waits. */
export const AUDIT_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const AUDIT_PRUNE_FIRST_DELAY_MS = 10 * 60 * 1000;

/**
 * The daemon's daily churn-prune loop. A failing pass logs and the loop keeps running. After a pass
 * that pruned anything, `PRAGMA incremental_vacuum` hands freed pages back — a no-op until
 * `musterd store compact` has switched the file to `auto_vacuum = INCREMENTAL` (ADR 478 §4).
 */
export function startAuditRetention(
  db: Database.Database,
  opts: { archiveDir: string | null; maxAgeMs?: number },
  onPass: (r: AuditPruneResult) => void,
  onError: (err: unknown) => void,
): () => void {
  const pass = () => {
    try {
      const r = pruneAuditChurn(db, {
        archiveDir: opts.archiveDir,
        ...(opts.maxAgeMs === undefined ? {} : { maxAgeMs: opts.maxAgeMs }),
      });
      if (r.pruned > 0) db.pragma('incremental_vacuum');
      onPass(r);
    } catch (err) {
      onError(err);
    }
  };
  const first = setTimeout(pass, AUDIT_PRUNE_FIRST_DELAY_MS);
  first.unref?.();
  const every = setInterval(pass, AUDIT_PRUNE_INTERVAL_MS);
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}

/** The store sizes `/health` reports (ADR 478 §Observability). Absent, never zero, when unknown. */
export function storeSizes(
  db: Database.Database,
  dbPath: string,
  archiveDir: string | null,
): { db_bytes?: number; sync_log_rows: number; sync_log_bytes?: number; archive_bytes?: number } {
  const out: ReturnType<typeof storeSizes> = {
    sync_log_rows: db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM sync_log').get()!.n,
  };
  if (dbPath !== ':memory:' && existsSync(dbPath)) out.db_bytes = statSync(dbPath).size;
  try {
    // dbstat is compiled into better-sqlite3's SQLite; the sum covers the table and its indexes.
    const r = db
      .prepare<
        [],
        { b: number | null }
      >("SELECT SUM(pgsize) AS b FROM dbstat WHERE name = 'sync_log' OR name LIKE 'idx_sync_log_%'")
      .get();
    if (r && r.b !== null) out.sync_log_bytes = r.b;
  } catch {
    // a build without dbstat: omit, do not guess
  }
  if (archiveDir && existsSync(archiveDir)) {
    out.archive_bytes = readdirSync(archiveDir).reduce(
      (n, f) => n + statSync(join(archiveDir, f)).size,
      0,
    );
  }
  return out;
}

/**
 * Which daemon source files read a churn action back by name (`action = '<churn>'` /
 * `action IN (…'<churn>'…)`), from `packages/server/src/{store,sync}` — the pin behind ADR 478's
 * "no daemon reader depends on churn past the window" claim. Writers (`action: '…'`), the fold's
 * `event.action ===` switch and this module are not reads and are not counted.
 */
export function auditReadersOfChurnActions(): Record<string, string[]> {
  const root = dirname(dirname(fileURLToPath(import.meta.url))); // packages/server/src
  const out: Record<string, Set<string>> = {};
  for (const sub of ['store', 'sync']) {
    for (const f of readdirSync(join(root, sub))) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'retention.ts') continue;
      const text = readFileSync(join(root, sub, f), 'utf8');
      for (const m of text.matchAll(/\baction\s*(?:=(?!=)|IN\s*\()\s*([^)\n]*)/g)) {
        for (const lit of m[1]!.matchAll(/'([a-z_.]+)'/g)) {
          const action = lit[1] as AuditAction;
          if (!AUDIT_CHURN_ACTIONS.has(action)) continue;
          (out[action] ??= new Set()).add(`${sub}/${f}`);
        }
      }
    }
  }
  return Object.fromEntries(
    Object.entries(out)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => [k, [...v].sort()]),
  );
}
