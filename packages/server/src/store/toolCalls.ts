import type {
  AdapterStartup,
  StartupDistribution,
  SeatSurfaceWeight,
  SurfaceRender,
  ToolCallEvent,
  ToolCallMetrics,
  ToolCallRail,
  ToolRailUsage,
  ToolUsageRow,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { appendAudit, appendReplicatedEvent } from './audit.js';

/**
 * Tool-call telemetry (ADR 144 increment 1) — the store behind the surface-redesign evals:
 * "which tools does each role actually call, at what cost, with what bounce rate", and "what does
 * each seat's rendered surface weigh". Ingest is best-effort observability (a failure must never
 * break the tool call it measures); the projection is derived at report time like everything else
 * in the insight engine.
 */

const BUCKET_MS = 60 * 60 * 1000; // hourly — 18 tools × 3 outcomes × a few seats stays tiny
const WINDOW_DAYS = 7;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;

/**
 * Fold one adapter flush into the hourly aggregate. Events are deltas accumulated adapter-side;
 * the whole batch lands in the arrival hour (a flush window is ≤ a minute — sub-bucket precision
 * isn't worth per-event timestamps on the wire). `role` is the caller's role at ingest,
 * server-resolved: it annotates the row (last write wins), it never keys it. `rail` keys it (ADR
 * 640): one seat's phone calls and desk calls are separate rows.
 */
export async function recordToolCalls(
  db: Driver,
  teamId: string,
  seat: string,
  role: string | null,
  events: ToolCallEvent[],
  now: number = Date.now(),
  rail: ToolCallRail = 'stdio',
): Promise<void> {
  if (events.length === 0) return;
  const bucket = now - (now % BUCKET_MS);
  const UPSERT = `INSERT INTO tool_call_stats
       (team_id, seat, role, rail, tool, outcome, bucket_start, calls, total_duration_ms,
        max_duration_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (team_id, seat, rail, tool, outcome, bucket_start) DO UPDATE SET
       calls = tool_call_stats.calls + excluded.calls,
       total_duration_ms = tool_call_stats.total_duration_ms + excluded.total_duration_ms,
       max_duration_ms = MAX(tool_call_stats.max_duration_ms, excluded.max_duration_ms),
       role = COALESCE(excluded.role, tool_call_stats.role)`;
  await db.tx(async (t) => {
    for (const e of events) {
      await t.run(UPSERT, [
        teamId,
        seat,
        role,
        rail,
        e.tool,
        e.outcome,
        bucket,
        e.calls,
        e.total_duration_ms,
        e.max_duration_ms,
      ]);
    }
  });
}

/**
 * Record a flush AND stamp it (ADR 371 §1): the batch lands in this daemon's aggregate through
 * `recordToolCalls`, and crosses the wire as one `record.tool_calls` event carrying the events and
 * the hour they landed in, so every peer folds the same delta into the same bucket. The two writes
 * share one transaction — a stamped event for a batch that was never counted here, or the reverse,
 * would be a report that disagrees with itself across machines. `recordToolCalls` stays the fold's
 * silent projector primitive (the `setPolicy` / `saveMemory` shape).
 */
export async function applyToolCalls(
  db: Driver,
  teamId: string,
  seat: string,
  role: string | null,
  events: ToolCallEvent[],
  now: number = Date.now(),
  rail: ToolCallRail = 'stdio',
): Promise<void> {
  if (events.length === 0) return;
  await db.tx(async (t) => {
    await recordToolCalls(t, teamId, seat, role, events, now, rail);
    await appendReplicatedEvent(t, teamId, {
      actor: seat,
      action: 'record.tool_calls',
      target: seat,
      result: 'allow',
      // `rail` rides the record (ADR 640); a fold that finds none counts it as stdio.
      detail: { seat, role, rail, bucket_start: now - (now % BUCKET_MS), events },
    });
  });
}

/**
 * Record a seat's attested rendered-surface weight as an append-only `mcp.surface_rendered` audit
 * row (the `residency.wake_cost` precedent: a measured cost the ledger carries). Once per adapter
 * session by contract (the adapter sends it on its first flush only), so the ledger stays legible.
 */
export async function recordSurfaceRender(
  db: Driver,
  teamId: string,
  seat: string,
  surface: SurfaceRender,
): Promise<void> {
  await appendAudit(db, teamId, {
    actor: seat,
    action: 'mcp.surface_rendered',
    target: seat,
    result: 'allow',
    detail: {
      tools: surface.tools,
      bytes: surface.bytes,
      est_tokens: surface.est_tokens,
      ...(surface.breakdown ? { breakdown: surface.breakdown } : {}),
    },
  });
}

/**
 * ADR 584: one adapter launch's startup as an append-only `mcp.startup_measured` row. Once per
 * adapter session by contract, so the row count is the launch count, and the window's rows ARE
 * the distribution — no aggregate table, since percentiles cannot be summed.
 */
export async function recordAdapterStartup(
  db: Driver,
  teamId: string,
  seat: string,
  startup: AdapterStartup,
): Promise<void> {
  await appendAudit(db, teamId, {
    actor: seat,
    action: 'mcp.startup_measured',
    target: seat,
    result: 'allow',
    detail: {
      surface: startup.surface,
      initialize_ms: startup.initialize_ms,
      tools_list_ms: startup.tools_list_ms,
    },
  });
}

/** Nearest-rank percentile of an ascending array; the array is never empty here. */
function nearestRank(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

/** ADR 584: adapter launch times per harness over the window, slowest-median first. */
export async function deriveStartupDistribution(
  db: Driver,
  teamId: string,
  since: number,
): Promise<StartupDistribution[]> {
  const rows = await db.all<{ detail: string | null }>(
    `SELECT detail FROM audit
        WHERE team_id = ? AND action = 'mcp.startup_measured' AND ts > ?`,
    [teamId, since],
  );
  const bySurface = new Map<string, { init: number[]; list: number[] }>();
  for (const r of rows) {
    try {
      const d = JSON.parse(r.detail ?? '{}') as Partial<AdapterStartup>;
      if (typeof d.surface !== 'string' || typeof d.tools_list_ms !== 'number') continue;
      let acc = bySurface.get(d.surface);
      if (!acc) bySurface.set(d.surface, (acc = { init: [], list: [] }));
      acc.list.push(d.tools_list_ms);
      if (typeof d.initialize_ms === 'number') acc.init.push(d.initialize_ms);
    } catch {
      /* best-effort rows stay skippable */
    }
  }
  const out: StartupDistribution[] = [];
  for (const [surface, { init, list }] of bySurface) {
    init.sort((a, b) => a - b);
    list.sort((a, b) => a - b);
    out.push({
      surface,
      launches: list.length,
      initialize_p50_ms: init.length > 0 ? nearestRank(init, 0.5) : null,
      initialize_p90_ms: init.length > 0 ? nearestRank(init, 0.9) : null,
      tools_list_p50_ms: nearestRank(list, 0.5),
      tools_list_p90_ms: nearestRank(list, 0.9),
    });
  }
  return out.sort(
    (a, b) => b.tools_list_p50_ms - a.tools_list_p50_ms || a.surface.localeCompare(b.surface),
  );
}

/** ADR 640: one tool's per-rail aggregate, as the report carries it. */
function railSplit(
  byRail: Map<string, { calls: number; total_ms: number; max_ms: number }>,
): Partial<Record<ToolCallRail, ToolRailUsage>> {
  const out: Partial<Record<ToolCallRail, ToolRailUsage>> = {};
  for (const [rail, a] of byRail) {
    if (rail !== 'stdio' && rail !== 'remote') continue;
    out[rail] = {
      calls: a.calls,
      avg_duration_ms: a.calls > 0 ? Math.round(a.total_ms / a.calls) : null,
      max_duration_ms: a.calls > 0 ? a.max_ms : null,
    };
  }
  return out;
}

interface StatRow {
  seat: string;
  role: string | null;
  rail: string;
  tool: string;
  outcome: string;
  calls: number;
  total_duration_ms: number;
  max_duration_ms: number;
}

/**
 * The tool-call block of the insight report: per-tool usage/bounce/latency over the window, plus
 * the latest attested surface weight per seat. One grouped pass over the aggregate + one over the
 * `mcp.surface_rendered` trail; diagnostic instruments, never a score.
 */
export async function deriveToolCallMetrics(
  db: Driver,
  teamId: string,
  now: number = Date.now(),
): Promise<ToolCallMetrics> {
  const since = now - WINDOW_MS;
  const rows = await db.all<StatRow>(
    `SELECT seat, role, rail, tool, outcome,
              -- CAST: SUM over 64-bit columns is numeric (a string) on Postgres.
              CAST(SUM(calls) AS INTEGER) AS calls,
              CAST(SUM(total_duration_ms) AS INTEGER) AS total_duration_ms,
              MAX(max_duration_ms) AS max_duration_ms
         FROM tool_call_stats
        WHERE team_id = ? AND bucket_start > ?
        GROUP BY seat, role, rail, tool, outcome`,
    [teamId, since],
  );

  interface ToolAcc {
    calls: number;
    errors: number;
    bounces: number;
    coerced: number;
    total_ms: number;
    max_ms: number;
    by_role: Record<string, number>;
    by_rail: Map<string, { calls: number; total_ms: number; max_ms: number }>;
  }
  const byTool = new Map<string, ToolAcc>();
  for (const r of rows) {
    let acc = byTool.get(r.tool);
    if (!acc)
      byTool.set(
        r.tool,
        (acc = {
          calls: 0,
          errors: 0,
          bounces: 0,
          coerced: 0,
          total_ms: 0,
          max_ms: 0,
          by_role: {},
          by_rail: new Map(),
        }),
      );
    acc.calls += r.calls;
    if (r.outcome === 'error') acc.errors += r.calls;
    if (r.outcome === 'invalid_input') acc.bounces += r.calls;
    // A coerced call succeeded, so it counts in `calls` and NOT in `bounces` — the bounce rate has
    // to keep meaning "cost the agent a turn", or inc 4 would flatter itself by construction.
    if (r.outcome === 'coerced') acc.coerced += r.calls;
    acc.total_ms += r.total_duration_ms;
    acc.max_ms = Math.max(acc.max_ms, r.max_duration_ms);
    const role = r.role ?? 'unroled';
    acc.by_role[role] = (acc.by_role[role] ?? 0) + r.calls;
    let rail = acc.by_rail.get(r.rail);
    if (!rail) acc.by_rail.set(r.rail, (rail = { calls: 0, total_ms: 0, max_ms: 0 }));
    rail.calls += r.calls;
    rail.total_ms += r.total_duration_ms;
    rail.max_ms = Math.max(rail.max_ms, r.max_duration_ms);
  }

  const tools: ToolUsageRow[] = [...byTool.entries()]
    .map(([tool, a]) => ({
      tool,
      calls: a.calls,
      errors: a.errors,
      bounces: a.bounces,
      bounce_rate: a.calls > 0 ? a.bounces / a.calls : null,
      coerced: a.coerced,
      avg_duration_ms: a.calls > 0 ? Math.round(a.total_ms / a.calls) : null,
      max_duration_ms: a.calls > 0 ? a.max_ms : null,
      by_role: a.by_role,
      // ADR 640 §5: split only when the tool was reached more than one way in the window.
      ...(a.by_rail.size > 1 ? { by_rail: railSplit(a.by_rail) } : {}),
    }))
    .sort((x, y) => y.calls - x.calls || x.tool.localeCompare(y.tool));

  // Latest attested weight per seat — an attestation like `presence.build`, so it is not
  // window-bound: the newest row per seat stands until the next session re-attests.
  const surfaceRows = await db.all<{ target: string | null; ts: number; detail: string | null }>(
    `SELECT target, ts, detail FROM audit
        WHERE team_id = ? AND action = 'mcp.surface_rendered'
        ORDER BY ts DESC, id DESC`,
    [teamId],
  );
  const surface: SeatSurfaceWeight[] = [];
  const seen = new Set<string>();
  for (const r of surfaceRows) {
    if (!r.target || seen.has(r.target)) continue;
    seen.add(r.target);
    try {
      const d = JSON.parse(r.detail ?? '{}') as {
        tools?: number;
        bytes?: number;
        est_tokens?: number;
      };
      if (typeof d.tools !== 'number' || typeof d.bytes !== 'number') continue;
      surface.push({
        seat: r.target,
        ts: r.ts,
        tools: d.tools,
        bytes: d.bytes,
        est_tokens: d.est_tokens ?? Math.round(d.bytes / 4),
      });
    } catch {
      /* best-effort rows stay skippable */
    }
  }
  surface.sort((a, b) => a.seat.localeCompare(b.seat));

  return {
    window_days: WINDOW_DAYS,
    calls: tools.reduce((n, t) => n + t.calls, 0),
    bounces: tools.reduce((n, t) => n + t.bounces, 0),
    coerced: tools.reduce((n, t) => n + t.coerced, 0),
    tools,
    surface,
    startup: await deriveStartupDistribution(db, teamId, since),
  };
}
