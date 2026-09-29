import {
  isAwaitingAcceptance,
  LANE_TERMINAL_STATES,
  type LaneState,
  TRACE_TOOL_MIX_TOP,
  type TraceCoverageRowSchema,
  type TraceLaneCostRowSchema,
  type TraceReport,
} from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import type { z } from 'zod';
import { POST_TOOL_USE_ONCE } from './traceCoverage.js';

/**
 * `musterd report trace` (ADR 445 increment 4): three views over `trace_events`' structural
 * columns. The content column is never read — the SELECTs name their columns, as
 * `dataset:export` does. Two stores are joined IN MEMORY (`trace.db` holds no lane, `musterd.db`
 * no trace), keyed by seat name, which both carry as text (ADR 445 §3).
 *
 * `seats` is the ADR 128 scope the route resolved: every seat for an admin, the caller's own
 * otherwise. Passing it in keeps the scoping decision at the boundary and this derivation pure.
 */

type UsageRow = {
  seat: string;
  harness: string;
  session_digest: string;
  ts: number;
  detail: string | null;
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

export function deriveTraceReport(
  db: Database,
  traceDb: Database,
  teamId: string,
  seats: readonly string[],
  opts: { days: number; now?: number },
): TraceReport {
  const now = opts.now ?? Date.now();
  const since = now - opts.days * 24 * 60 * 60 * 1000;
  const inSeats = seats.length > 0 ? `AND seat IN (${seats.map(() => '?').join(',')})` : 'AND 0';
  const seatArgs = [...seats];

  // ── coverage: R1 PostToolUse ÷ R2 usage.tool_uses, per harness ──
  const sessions = traceDb
    .prepare<
      [string, number, ...string[]],
      { harness: string; session_digest: string; has_r2: number; post: number; post_main: number }
    >(
      `SELECT harness, session_digest,
              -- An R2 session is one whose transcript rail can COUNT calls. A rail that posted
              -- tokens and no tool_uses (codex@1) is no denominator: with it, codex read 1.47 on
              -- the dogfood box, 11 of 11 sessions "with R2" over 1,289 calls (lane 01M3NMDWA9).
              MAX(CASE WHEN kind = 'usage' AND json_extract(detail, '$.tool_uses') IS NOT NULL
                       THEN 1 ELSE 0 END) AS has_r2,
              SUM(CASE WHEN kind IN ('PostToolUse', 'PostToolUseFailure') AND agent_id IS NOT NULL
                       THEN 1 ELSE 0 END) + ${POST_TOOL_USE_ONCE} AS post,
              ${POST_TOOL_USE_ONCE} AS post_main
         FROM trace_events
        WHERE team_id = ? AND ts >= ? ${inSeats}
        GROUP BY harness, session_digest`,
    )
    .all(teamId, since, ...seatArgs);
  const usage = traceDb
    .prepare<[string, number, ...string[]], UsageRow>(
      `SELECT seat, harness, session_digest, ts, detail FROM trace_events
        WHERE team_id = ? AND ts >= ? AND kind = 'usage' ${inSeats}
        ORDER BY ts`,
    )
    .all(teamId, since, ...seatArgs);

  const cov = new Map<string, z.infer<typeof TraceCoverageRowSchema>>();
  for (const s of sessions) {
    const row = cov.get(s.harness) ?? {
      harness: s.harness,
      sessions: 0,
      sessions_with_r2: 0,
      post_tool_use: 0,
      post_tool_use_r2: 0,
      r2_tool_uses: 0,
      coverage: null,
    };
    row.sessions++;
    row.post_tool_use += s.post;
    // The ratio compares like with like: hook calls from the sessions the transcript rail also
    // covers. Counting every session's hook calls over only the R2-bearing sessions' transcript
    // calls read 124% on the live team (8 sessions, 2 with R2) — a number that meant nothing.
    // A subagent's calls fire hooks in the parent session (with `agent_id`), but its transcript is
    // a sidechain file the tail does not read — so they are left out of the ratio's numerator
    // (307 of the 382 calls claude-code read OVER its R2 count, measured 2026-09-28).
    if (s.has_r2) {
      row.sessions_with_r2++;
      row.post_tool_use_r2 += s.post_main;
    }
    cov.set(s.harness, row);
  }
  const parsedUsage = usage.map((u) => {
    let d: Record<string, unknown> = {};
    try {
      d = u.detail ? (JSON.parse(u.detail) as Record<string, unknown>) : {};
    } catch {
      d = {};
    }
    return { ...u, d };
  });
  for (const u of parsedUsage) {
    const row = cov.get(u.harness);
    if (row) row.r2_tool_uses += num(u.d['tool_uses']);
  }
  for (const row of cov.values()) {
    row.coverage = row.r2_tool_uses > 0 ? row.post_tool_use_r2 / row.r2_tool_uses : null;
  }

  // ── tool mix ──
  const tools = traceDb
    .prepare<
      [string, number, ...string[]],
      { harness: string; tool: string; calls: number; errors: number; avg: number | null }
    >(
      `SELECT harness, tool_name AS tool, COUNT(*) AS calls,
              SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
              AVG(duration_ms) AS avg
         FROM trace_events
        WHERE team_id = ? AND ts >= ? AND kind IN ('PostToolUse','PostToolUseFailure')
          AND tool_name IS NOT NULL ${inSeats}
        GROUP BY harness, tool_name
        ORDER BY calls DESC, tool, harness
        LIMIT ${TRACE_TOOL_MIX_TOP}`,
    )
    .all(teamId, since, ...seatArgs)
    .map((t) => ({
      harness: t.harness,
      tool: t.tool,
      calls: t.calls,
      errors: t.errors,
      avg_duration_ms: t.avg === null ? null : Math.round(t.avg),
    }));

  // ── cost per lane: each usage row → the seat's most recently claimed lane open at its ts ──
  // A lane's window is claim → MERGE, the same window ADR 462's archaeology uses. The lane row has
  // no merge timestamp, so the submit (`lane.ready_for_review`, which follows the merge) stands in
  // for it. Bounding at `resolved_at` instead held a landed lane open for as long as its acceptor
  // took, and charged the seat's NEXT work to it (ryder, 2026-09-28). The submit only bounds a lane
  // that is still submitted or closed: a rejected lane is back in work, and its old submit is not
  // the end of anything.
  const lanes = db
    .prepare<
      [string],
      {
        id: string;
        title: string;
        state: string;
        owner_seat: string;
        goal_id: string | null;
        claimed_at: number;
        resolved_at: number | null;
      }
    >(
      `SELECT id, title, state, owner_seat, goal_id, claimed_at, resolved_at FROM lanes
        WHERE team_id = ? AND owner_seat IS NOT NULL AND claimed_at IS NOT NULL
        ORDER BY claimed_at DESC`,
    )
    .all(teamId);
  const submittedAt = new Map(
    db
      .prepare<[string], { target: string; ts: number }>(
        `SELECT target, MAX(ts) AS ts FROM audit
          WHERE team_id = ? AND action = 'lane.ready_for_review'
          GROUP BY target`,
      )
      .all(teamId)
      .map((r) => [r.target, r.ts]),
  );
  const windowEnd = (l: (typeof lanes)[number]): number | null => {
    const submitted = submittedAt.get(l.id);
    const bounded = isAwaitingAcceptance(l.state) || LANE_TERMINAL_STATES.has(l.state as LaneState);
    if (bounded && submitted !== undefined && submitted >= l.claimed_at) {
      return l.resolved_at === null ? submitted : Math.min(submitted, l.resolved_at);
    }
    return l.resolved_at;
  };
  const bySeat = new Map<string, typeof lanes>();
  for (const l of lanes) {
    const list = bySeat.get(l.owner_seat) ?? [];
    list.push(l);
    bySeat.set(l.owner_seat, list);
  }
  const cost = new Map<string, z.infer<typeof TraceLaneCostRowSchema>>();
  const unattributed = { turns: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 };
  for (const u of parsedUsage) {
    // lanes are DESC by claimed_at, so the first open one at `ts` is the most recently claimed
    const lane = (bySeat.get(u.seat) ?? []).find((l) => {
      const end = windowEnd(l);
      return l.claimed_at <= u.ts && (end === null || u.ts <= end);
    });
    const tokens = {
      input_tokens: num(u.d['input_tokens']),
      output_tokens: num(u.d['output_tokens']),
      cache_read_tokens: num(u.d['cache_read_tokens']),
    };
    if (!lane) {
      unattributed.turns++;
      unattributed.input_tokens += tokens.input_tokens;
      unattributed.output_tokens += tokens.output_tokens;
      unattributed.cache_read_tokens += tokens.cache_read_tokens;
      continue;
    }
    const row = cost.get(lane.id) ?? {
      lane: lane.id,
      title: lane.title,
      state: lane.state,
      seat: lane.owner_seat,
      goal_id: lane.goal_id,
      turns: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
    };
    row.turns++;
    row.input_tokens += tokens.input_tokens;
    row.output_tokens += tokens.output_tokens;
    row.cache_read_tokens += tokens.cache_read_tokens;
    cost.set(lane.id, row);
  }

  return {
    window_days: opts.days,
    seats: [...seats],
    coverage: [...cov.values()].sort((a, b) => a.harness.localeCompare(b.harness)),
    tool_mix: tools,
    lane_cost: [...cost.values()].sort(
      (a, b) => b.output_tokens + b.input_tokens - (a.output_tokens + a.input_tokens),
    ),
    unattributed,
  };
}
