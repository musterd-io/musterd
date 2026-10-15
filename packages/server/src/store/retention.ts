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
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statfsSync,
  statSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { readNodeState } from '../node/state.js';
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
  // ADR 536 inc 3: one row per brief read; `pnpm next:readout` reads live rows + the archive.
  'next.offer',
]);

/** Churn actions a daemon query reads as "newest row per seat, unbounded" — that row is kept. */
const LATEST_PER_SEAT: ReadonlySet<AuditAction> = new Set<AuditAction>([
  'occupancy.model_attested',
  'mcp.surface_rendered',
]);

/** How long churn stays in the live store (ADR 478 §1; 5 days since ADR 480). The daemon passes
 *  `config.auditChurnRetentionMs`; this is the function's fallback. */
export const AUDIT_CHURN_MAX_AGE_MS = 5 * 24 * 60 * 60 * 1000;

/** Rows per prune transaction, and transactions per pass — same reasoning as the trace prune. */
export const AUDIT_PRUNE_BATCH = 5_000;
export const AUDIT_PRUNE_MAX_BATCHES = 20;

/** `schema_meta` key `corpus:snapshot` stamps on the coordination store: `MAX(ts)` of the captured
 *  `audit`. `scripts/corpus/snapshot.ts` carries its own copy; the test pins that they agree. */
export const AUDIT_CAPTURED_THROUGH_KEY = 'audit_captured_through';

/** The capture watermark, or null on a machine that never archived. */
export async function auditCapturedThrough(db: Driver): Promise<number | null> {
  const row = await db.get<{ value: string }>('SELECT value FROM schema_meta WHERE key = ?', [
    AUDIT_CAPTURED_THROUGH_KEY,
  ]);
  const n = row ? Number(row.value) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** `~/.musterd/archive` beside the store; null for an in-memory store (nothing to archive to). */
export function defaultArchiveDir(dbPath: string): string | null {
  // Only a file-backed store has a directory to archive beside: `:memory:` and a Postgres store
  // (`postgres`, index.ts) are not paths.
  return isAbsolute(dbPath) ? join(dirname(dbPath), 'archive') : null;
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

/** Where a Cloud store archives: the `audit_archive` table (v97), named in `store.pruned`. */
export const AUDIT_ARCHIVE_TABLE = 'audit_archive';

const churnList = () => [...AUDIT_CHURN_ACTIONS].map((a) => `'${a}'`).join(', ');
const latestList = () => [...LATEST_PER_SEAT].map((a) => `'${a}'`).join(', ');

/**
 * The prunable set: churn, older than `?` (the cutoff), minus the rows kept whatever their age.
 *
 * The keep sets are computed ONCE as CTEs, not as per-row correlated subqueries: the correlated form
 * stalled the live daemon on 2026-09-29 (300k rows; a `LIMIT 5000` batch did not return in 280 s,
 * and SQLite work is synchronous, so the daemon answered nothing meanwhile). This form counts the
 * whole prunable set of that store in ~4 s.
 */
/**
 * A joiner's own rows the hub has not acked: `[node, last acked seq]` per enrolled team. The hub
 * requires a dense `origin_seq` per node (sync/log.ts SyncGapError → 409), so pruning one of these
 * would turn a refused or unreachable push into a permanent 409 livelock (lane 01M3ZBT9VY). A hub
 * or a never-enrolled daemon has no enrollment, so nothing extra is kept there.
 */
async function unpushedFloors(db: Driver): Promise<[string, number][]> {
  const enrolled = readNodeState().nodes;
  const locals = await db.all<{ slug: string; node_id: string; last_seq: number | null }>(
    `SELECT t.slug, l.node_id, c.last_seq FROM local_node l
       JOIN teams t ON t.id = l.team_id
       LEFT JOIN sync_push_cursor c ON c.team_id = l.team_id AND c.node_id = l.node_id`,
  );
  return locals
    .filter((l) => enrolled[l.slug]?.node_id === l.node_id)
    .map((l) => [l.node_id, l.last_seq ?? 0]);
}

function prunableSql(floors: number): string {
  return `
    WITH hwm AS (
      SELECT origin_node, MAX(origin_seq) AS seq FROM audit WHERE origin_seq > 0 GROUP BY origin_node
    ),
    latest AS (
      SELECT id FROM (
        SELECT id, row_number() OVER (PARTITION BY team_id, action, target ORDER BY ts DESC, id DESC) AS rn
          FROM audit WHERE action IN (${latestList()})
      ) WHERE rn = 1
    )
    SELECT a.* FROM audit a
     WHERE a.action IN (${churnList()})
       AND a.ts < ?
       AND NOT EXISTS (SELECT 1 FROM hwm h
                        WHERE a.origin_seq > 0 AND h.origin_node = a.origin_node AND h.seq = a.origin_seq)
       AND a.id NOT IN (SELECT id FROM latest)
       ${'AND NOT (a.origin_node = ? AND a.origin_seq > ?) '.repeat(floors)}
     ORDER BY a.ts, a.id`;
}

/**
 * Archive-then-prune one pass of churn rows older than the window and below the watermark.
 *
 * Kept whatever their age (ADR 478 §1): for each `origin_node` the row holding `MAX(origin_seq)`
 * (`sync/fold.ts` reads it as the peer's high-water mark), and for the latest-per-seat actions the
 * newest row per `(team, target)`. On an enrolled joiner, also every row of its own node above the
 * push cursor — the hub has not acked it yet (see {@link unpushedFloors}). Each batch is gzipped and appended to
 * `<archiveDir>/audit-YYYY-MM.jsonl.gz` (one gzip member per batch — `gunzip` reads them all)
 * BEFORE the delete runs; a failed archive write throws and deletes nothing.
 *
 * `archiveTable: true` is Cloud's form (a Fly VM's disk is ephemeral, so a file beside the store
 * would be lost with the machine): each batch goes into `audit_archive` instead, one row per team
 * and month, the same gzip bytes base64-encoded, inside the SAME transaction as its delete — a
 * failed insert rolls the delete back. Only rows that transaction actually deleted are archived and
 * counted, so two servers pruning at once never archive a row twice. `archiveDir` is ignored then.
 */
export async function pruneAuditChurn(
  db: Driver,
  opts: {
    now?: number;
    maxAgeMs?: number;
    batch?: number;
    maxBatches?: number;
    archiveDir: string | null;
    archiveTable?: boolean;
  },
): Promise<AuditPruneResult> {
  const now = opts.now ?? Date.now();
  const windowCutoff = now - (opts.maxAgeMs ?? AUDIT_CHURN_MAX_AGE_MS);
  const capturedThrough = await auditCapturedThrough(db);
  const cutoff = capturedThrough === null ? windowCutoff : Math.min(windowCutoff, capturedThrough);
  const perTeam: Record<string, number> = {};
  if (opts.archiveDir === null && !opts.archiveTable) {
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
  const floors = await unpushedFloors(db);
  const SELECT = `${prunableSql(floors.length)} LIMIT ?`;
  const deleteAll = async (t: Driver, ids: string[]) => {
    for (const id of ids) await t.run('DELETE FROM audit WHERE id = ?', [id]);
  };
  let pruned = 0;
  let archivedBytes = 0;
  for (let i = 0; i < maxBatches; i++) {
    const rows = await db.all<AuditRow>(SELECT, [cutoff, ...floors.flat(), batch]);
    if (rows.length === 0) break;
    let taken = rows;
    if (opts.archiveTable) {
      // Every Cloud server runs this loop, so two can select the same batch. Delete first and
      // archive only the rows THIS transaction deleted: the other server's delete of a row waits on
      // ours and then removes nothing, so no row is archived twice.
      const done = await db.tx(async (t) => {
        const gone: AuditRow[] = [];
        for (const row of rows) {
          const { changes } = await t.run('DELETE FROM audit WHERE id = ?', [row.id]);
          if (changes > 0) gone.push(row);
        }
        return { gone, bytes: gone.length ? await archiveRowsToTable(t, gone, now) : 0 };
      });
      taken = done.gone;
      archivedBytes += done.bytes;
    } else {
      archivedBytes += archiveRows(opts.archiveDir!, rows);
      await db.tx((t) =>
        deleteAll(
          t,
          rows.map((r) => r.id),
        ),
      );
    }
    for (const r of taken) perTeam[r.team_id] = (perTeam[r.team_id] ?? 0) + 1;
    pruned += taken.length;
    if (rows.length < batch) break;
  }
  return { pruned, archivedBytes, cutoff, capturedThrough, perTeam };
}

/** `YYYY-MM` (UTC) of a row's `ts` — the archive's file and table grouping. */
function monthOf(ts: number): string {
  const d = new Date(ts);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** Append the rows, grouped by the month of their `ts`, as one gzip member per file. */
function archiveRows(dir: string, rows: AuditRow[]): number {
  mkdirSync(dir, { recursive: true });
  const byMonth = new Map<string, string[]>();
  for (const r of rows) {
    const key = monthOf(r.ts);
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

/**
 * Cloud's archive: the rows grouped by (team, month), each group one `audit_archive` row whose
 * `body` is the base64 of the gzipped JSONL — `gunzip` of the decoded body is exactly what a local
 * archive member holds. Grouped by team so the row sits under that team's tenant policy and a
 * per-team dump or export carries only its own rows. Returns the gzip bytes (before base64).
 */
async function archiveRowsToTable(t: Driver, rows: AuditRow[], now: number): Promise<number> {
  const groups = new Map<string, AuditRow[]>();
  for (const r of rows) {
    const key = `${r.team_id}|${monthOf(r.ts)}`; // neither a team id nor a month holds a '|'
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  let bytes = 0;
  for (const [key, g] of groups) {
    const [teamId, month] = key.split('|') as [string, string];
    const gz = gzipSync(`${g.map((r) => JSON.stringify(r)).join('\n')}\n`);
    await t.run(
      `INSERT INTO ${AUDIT_ARCHIVE_TABLE} (id, team_id, month, row_count, from_ts, to_ts, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        ulid(now),
        teamId,
        month,
        g.length,
        Math.min(...g.map((r) => r.ts)),
        Math.max(...g.map((r) => r.ts)),
        gz.toString('base64'),
        now,
      ],
    );
    bytes += gz.byteLength;
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
  db: Driver,
  opts: { archiveDir: string | null; archiveTable?: boolean; maxAgeMs?: number },
  onPass: (r: AuditPruneResult) => void,
  onError: (err: unknown) => void,
): () => void {
  const pass = async () => {
    try {
      const r = await pruneAuditChurn(db, {
        archiveDir: opts.archiveDir,
        ...(opts.archiveTable ? { archiveTable: true } : {}),
        ...(opts.maxAgeMs === undefined ? {} : { maxAgeMs: opts.maxAgeMs }),
      });
      if (r.pruned > 0 && db.dialect === 'sqlite') await db.exec('PRAGMA incremental_vacuum');
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
export interface StoreSizes {
  db_bytes?: number;
  sync_log_rows: number;
  sync_log_bytes?: number;
  archive_bytes?: number;
}

/** `bytes: false` skips `sync_log_bytes`: on SQLite it is a `dbstat` walk of every sync_log page —
 *  0.8 s warm and 15 s cold on the hub (2026-10-12) — and synchronous. See `healthStoreSizes`. */
export async function storeSizes(
  db: Driver,
  dbPath: string,
  archiveDir: string | null,
  opts: { bytes?: boolean } = {},
): Promise<StoreSizes> {
  const out: StoreSizes = {
    sync_log_rows: (await db.get<{ n: number }>('SELECT COUNT(*) AS n FROM sync_log'))!.n,
  };
  if (dbPath !== ':memory:' && existsSync(dbPath)) out.db_bytes = statSync(dbPath).size;
  if (opts.bytes !== false) await syncLogBytes(db, out);
  if (archiveDir && existsSync(archiveDir)) {
    out.archive_bytes = readdirSync(archiveDir).reduce(
      (n, f) => n + statSync(join(archiveDir, f)).size,
      0,
    );
  }
  return out;
}

async function syncLogBytes(db: Driver, out: StoreSizes): Promise<void> {
  try {
    // The table plus its indexes: dbstat is compiled into better-sqlite3's SQLite; Postgres has
    // pg_total_relation_size. Engine introspection, not store SQL — the one dialect branch here.
    const r =
      db.dialect === 'postgres'
        ? await db.get<{ b: number | null }>("SELECT pg_total_relation_size('sync_log') AS b")
        : await db.get<{ b: number | null }>(
            "SELECT SUM(pgsize) AS b FROM dbstat WHERE name = 'sync_log' OR name LIKE 'idx_sync_log_%'",
          );
    if (r && r.b !== null) out.sync_log_bytes = Number(r.b);
  } catch {
    // a build without dbstat: omit, do not guess
  }
}

/** How many churn rows a pass would take right now — `musterd store prune --dry-run`. */
export async function countPrunableAuditChurn(
  db: Driver,
  opts: { now?: number; maxAgeMs?: number } = {},
): Promise<{ rows: number; cutoff: number; capturedThrough: number | null }> {
  const now = opts.now ?? Date.now();
  const windowCutoff = now - (opts.maxAgeMs ?? AUDIT_CHURN_MAX_AGE_MS);
  const capturedThrough = await auditCapturedThrough(db);
  const cutoff = capturedThrough === null ? windowCutoff : Math.min(windowCutoff, capturedThrough);
  const floors = await unpushedFloors(db);
  const rows = (await db.get<{ n: number }>(
    `SELECT COUNT(*) AS n FROM (${prunableSql(floors.length)})`,
    [cutoff, ...floors.flat()],
  ))!.n;
  return { rows, cutoff, capturedThrough };
}

/** Free space must cover this many copies of the file before `VACUUM` runs (ADR 478 §4). */
export const COMPACT_MIN_FREE_RATIO = 1.2;

export type CompactResult =
  | { ok: true; before_bytes: number; after_bytes: number; auto_vacuum: 'incremental' }
  | { ok: false; reason: 'in_memory' }
  | { ok: false; reason: 'insufficient_disk'; need_bytes: number; free_bytes: number };

/**
 * The one-time reclaim (`musterd store compact`, ADR 478 §4): flip the file to
 * `auto_vacuum = INCREMENTAL` — which only takes effect through a full `VACUUM` — and run that
 * `VACUUM`. It rewrites the whole file, so it refuses unless free disk is at least
 * {@link COMPACT_MIN_FREE_RATIO} × the file, and it holds the write lock for the duration: an
 * operator verb, announced first, never a timer's.
 */
export async function compactStore(
  db: Driver,
  dbPath: string,
  opts: { freeBytes?: (dir: string) => number } = {},
): Promise<CompactResult> {
  if (dbPath === ':memory:' || !existsSync(dbPath)) return { ok: false, reason: 'in_memory' };
  const before = statSync(dbPath).size;
  const free = (opts.freeBytes ?? defaultFreeBytes)(dirname(dbPath));
  const need = Math.ceil(before * COMPACT_MIN_FREE_RATIO);
  if (free < need)
    return { ok: false, reason: 'insufficient_disk', need_bytes: need, free_bytes: free };
  // VACUUM / auto_vacuum / WAL are SQLite-only operations by nature.
  if (db.dialect !== 'sqlite') return { ok: false, reason: 'in_memory' };
  await db.exec('PRAGMA auto_vacuum = INCREMENTAL');
  await db.exec('VACUUM');
  await db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return {
    ok: true,
    before_bytes: before,
    after_bytes: statSync(dbPath).size,
    auto_vacuum: 'incremental',
  };
}

function defaultFreeBytes(dir: string): number {
  const st = statfsSync(dir);
  return Number(st.bavail) * Number(st.bsize);
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
