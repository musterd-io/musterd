import type { Driver } from '../db/driver.js';

/**
 * ADR 445 §Observability: "a session below [0.98 tool coverage] is audited as
 * `trace.coverage_low`". Coverage is rail R1's count of tool calls that ended (`PostToolUse` +
 * `PostToolUseFailure`) over rail R2's transcript tool count (the `usage` rows' `tool_uses`), per
 * session — the same ratio `report trace` shows per harness. On `SubagentStop` the tail reads the
 * subagent's sidechain transcript into the parent session with `agent_id` set (lane 01M4VTRMXYZ),
 * so subagent calls count in both rails once a subagent's R2 has landed, while a session whose R1
 * carries subagent calls from before this tap (no subagent `usage` rows) still counts only the
 * main loop in the ratio.
 *
 * What still reads low on Claude Code (measured 2026-09-28, 5 of 7 flagged sessions) is not a tap
 * miss: a call refused before it ran (a permission check, a blocked command) fires no Post hook,
 * and a harness built-in like `ToolSearch` fires no hook at all, yet both are `tool_use` blocks in
 * the transcript. The audit says so by construction — it names the counts, not a cause.
 *
 * A session is judged once it has gone QUIET, not at SessionEnd. Every harness's final R2 rows
 * post after its SessionEnd event (Grok and Cursor post ALL of theirs then), so judging at
 * SessionEnd would read a partial denominator and flag sessions that are fine. A session only one
 * rail reached is not judged at all: no R2 count is "cannot tell", never 0%.
 *
 * Pure over the two stores; the caller writes the audit rows (`index.ts`), as the expired-member
 * sweep does. Dedupe is by the audit ledger itself: a digest already audited is skipped.
 */

export const TRACE_COVERAGE_TARGET = 0.98;
/** How long a session must be silent before it is judged: both rails have landed by then. */
export const TRACE_COVERAGE_QUIET_MS = 30 * 60 * 1000;
/** How far back the sweep looks. Older sessions were judged by an earlier pass, or predate it. */
export const TRACE_COVERAGE_LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
export const TRACE_COVERAGE_INTERVAL_MS = 60 * 60 * 1000;
export const TRACE_COVERAGE_FIRST_DELAY_MS = 2 * 60 * 1000;

/**
 * Rail R1's count of a session's tool calls, as a SQL aggregate over its rows: one call is one
 * call. Cursor fires `afterShellExecution` / `afterMCPExecution` BESIDE `postToolUse` for the same
 * call (on cursor-agent too — wanderer's 0e58c84e read 86 + 91 hook rows for 92 shell calls, lane
 * 01M3N78KVY) and the tap records all three as `PostToolUse`, with the source in
 * `detail.hook_event`. So the after-rows count only when the session has no `postToolUse` spelling
 * at all — then they are its whole record. Other harnesses carry no `hook_event` and count as is.
 *
 * And one call id counts once however many rows carry it: cursor-agent re-emits `postToolUse` for
 * a call it is still on (wanderer's 0e58c84e: one Read fired 26 times — 144 Read rows over 106
 * ids, lane 01M3N8GF8D). A row with no `tool_use_id` (older taps, harnesses that send none) is its
 * own call, so the count never drops below what such rows would have read before.
 *
 * Subagent calls (`agent_id IS NOT NULL`) count in the ratio's numerator once the session also has
 * subagent R2 `usage` rows (tailed on `SubagentStop`, lane 01M4VTRMXYZ); sessions from before the
 * sidechain tail have no subagent `usage` rows and keep counting main-loop calls only, so legacy
 * sessions do not inflate above 100%.
 */
// Grok's R1 row per call is its PreToolUse probe (ADR 445, 2026-09-28: the probe has no matcher,
// so it records every call; the gate posts only its HookOutcome). Grok's PostToolUse is never
// tapped, so without this every Grok session read R1 = 0 (lane 01M3R8G033).
export const CALL_ROW = `(kind IN ('PostToolUse', 'PostToolUseFailure')
                   OR (harness = 'grok' AND kind = 'PreToolUse'))`;
const MAIN_POST = `${CALL_ROW} AND agent_id IS NULL`;
const PRIMARY_SPELLING = `COALESCE(json_extract(detail, '$.hook_event'), '')
                          NOT IN ('afterShellExecution', 'afterMCPExecution')`;
const HAS_SUBAGENT_R2 = `SUM(CASE WHEN kind = 'usage' AND agent_id IS NOT NULL
                                   AND json_extract(detail, '$.tool_uses') IS NOT NULL
                             THEN 1 ELSE 0 END) > 0`;
const ALL_POST_ONCE = `
  CASE WHEN SUM(CASE WHEN ${CALL_ROW} AND ${PRIMARY_SPELLING} THEN 1 ELSE 0 END) > 0
       THEN COUNT(DISTINCT CASE WHEN ${CALL_ROW} AND ${PRIMARY_SPELLING}
                                THEN COALESCE(tool_use_id, id) END)
       ELSE COUNT(DISTINCT CASE WHEN ${CALL_ROW} THEN COALESCE(tool_use_id, id) END)
  END`;
const MAIN_POST_ONCE = `
  CASE WHEN SUM(CASE WHEN ${MAIN_POST} AND ${PRIMARY_SPELLING} THEN 1 ELSE 0 END) > 0
       THEN COUNT(DISTINCT CASE WHEN ${MAIN_POST} AND ${PRIMARY_SPELLING}
                                THEN COALESCE(tool_use_id, id) END)
       ELSE COUNT(DISTINCT CASE WHEN ${MAIN_POST} THEN COALESCE(tool_use_id, id) END)
  END`;
export const POST_TOOL_USE_ONCE = `
  CASE WHEN ${HAS_SUBAGENT_R2}
       THEN ${ALL_POST_ONCE}
       ELSE ${MAIN_POST_ONCE}
  END`;
export const POST_TOOL_USE_ALL = ALL_POST_ONCE;

export interface LowCoverageSession {
  team_id: string;
  seat: string;
  harness: string;
  session_digest: string;
  post_tool_use: number;
  r2_tool_uses: number;
  coverage: number;
}

export async function findLowCoverageSessions(
  db: Driver,
  traceDb: Driver,
  now: number = Date.now(),
): Promise<LowCoverageSession[]> {
  const quietBefore = now - TRACE_COVERAGE_QUIET_MS;
  const since = now - TRACE_COVERAGE_LOOKBACK_MS;
  // Rows are read one window further back than sessions are judged, so a long session's early
  // R1 rows are still counted: a truncated numerator would read as a false low.
  const sessions = await traceDb.all<{
    team_id: string;
    seat: string;
    harness: string;
    session_digest: string;
    post: number;
    r2: number;
    last: number;
  }>(
    `SELECT team_id, seat, MIN(harness) AS harness, session_digest,
            ${POST_TOOL_USE_ONCE} AS post,
            CAST(SUM(CASE WHEN kind = 'usage'
                     THEN COALESCE(CAST(json_extract(detail, '$.tool_uses') AS INTEGER), 0) ELSE 0 END) AS INTEGER) AS r2,
            MAX(received_at) AS last
       FROM trace_events
      WHERE received_at >= ?
      GROUP BY team_id, seat, session_digest
     -- The aggregates, not their aliases: Postgres cannot see a SELECT alias from HAVING.
     HAVING MAX(received_at) >= ? AND MAX(received_at) < ?
        AND SUM(CASE WHEN kind = 'usage' THEN COALESCE(CAST(json_extract(detail, '$.tool_uses') AS INTEGER), 0) ELSE 0 END) > 0`,
    [since - TRACE_COVERAGE_LOOKBACK_MS, since, quietBefore],
  );
  const low = sessions.filter((s) => s.post / s.r2 < TRACE_COVERAGE_TARGET);
  if (low.length === 0) return [];
  const audited = new Set(
    (
      await db.all<{ team_id: string; digest: string | null }>(
        `SELECT team_id, json_extract(detail, '$.session_digest') AS digest FROM audit
          WHERE action = 'trace.coverage_low' AND ts >= ?`,
        [since - TRACE_COVERAGE_LOOKBACK_MS],
      )
    ).map((r) => `${r.team_id}\u0000${r.digest ?? ''}`),
  );
  return low
    .filter((s) => !audited.has(`${s.team_id}\u0000${s.session_digest}`))
    .map((s) => ({
      team_id: s.team_id,
      seat: s.seat,
      harness: s.harness,
      session_digest: s.session_digest,
      post_tool_use: s.post,
      r2_tool_uses: s.r2,
      coverage: Math.round((s.post / s.r2) * 1000) / 1000,
    }));
}

/**
 * The daemon's coverage sweep. A failing pass logs and the loop keeps running. Returns the stop
 * function `close()` calls.
 */
export function startTraceCoverageSweep(
  db: Driver,
  traceDb: Driver,
  onFound: (sessions: LowCoverageSession[]) => void,
  onError: (err: unknown) => void,
): () => void {
  const pass = async () => {
    try {
      const found = await findLowCoverageSessions(db, traceDb);
      if (found.length > 0) onFound(found);
    } catch (err) {
      onError(err);
    }
  };
  const tick = () => void pass();
  const first = setTimeout(tick, TRACE_COVERAGE_FIRST_DELAY_MS);
  first.unref?.();
  const every = setInterval(tick, TRACE_COVERAGE_INTERVAL_MS);
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
