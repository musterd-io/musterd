import type { TraceEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openTraceDb } from '../db/traceDb.js';
import { appendAudit } from './audit.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';
import { ingestTraceEvents } from './trace.js';
import { findLowCoverageSessions, TRACE_COVERAGE_QUIET_MS } from './traceCoverage.js';

const H = 60 * 60 * 1000;

function fixture() {
  const db = openDb(':memory:');
  const traceDb = openTraceDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  addMember(db, team, { name: 'ryder', kind: 'agent' });
  return { db, traceDb, team };
}

/** `n` hook calls and one transcript usage row claiming `r2` calls, for one session. */
const session = (digest: string, n: number, r2: number, ts: number): TraceEvent[] => [
  ...Array.from({ length: n }, () => ({
    harness: 'claude-code',
    session_digest: digest,
    ts,
    kind: 'PostToolUse' as const,
    tool_name: 'Bash',
  })),
  {
    harness: 'claude-code',
    session_digest: digest,
    ts,
    kind: 'usage',
    detail: { parser: 'claude-code@1', tool_uses: r2 },
  },
];

describe('findLowCoverageSessions (ADR 445 trace.coverage_low)', () => {
  it('judges quiet two-rail sessions only, below 0.98, once per digest', () => {
    const { db, traceDb, team } = fixture();
    // received_at is stamped at ingest (Date.now()), so "now" is set relative to it.
    ingestTraceEvents(traceDb, team.id, 'ryder', [
      ...session('aaaaaaaaaaaa', 9, 10, 1), // 0.9 → low
      ...session('bbbbbbbbbbbb', 99, 100, 1), // 0.99 → fine
      ...session('cccccccccccc', 11, 10, 1), // over 1 → not low
    ]);
    ingestTraceEvents(traceDb, team.id, 'ryder', [
      // R1 only: no denominator, cannot tell — never judged
      { harness: 'grok', session_digest: 'dddddddddddd', ts: 1, kind: 'PostToolUse' },
    ]);
    const later = Date.now() + TRACE_COVERAGE_QUIET_MS + 1000;

    // still live: nothing judged yet
    expect(findLowCoverageSessions(db, traceDb, Date.now())).toEqual([]);

    const found = findLowCoverageSessions(db, traceDb, later);
    expect(found).toEqual([
      {
        team_id: team.id,
        seat: 'ryder',
        harness: 'claude-code',
        session_digest: 'aaaaaaaaaaaa',
        post_tool_use: 9,
        r2_tool_uses: 10,
        coverage: 0.9,
      },
    ]);

    // once audited, the next pass skips it
    appendAudit(db, team.id, {
      actor: null,
      action: 'trace.coverage_low',
      target: 'ryder',
      result: 'allow',
      detail: { session_digest: 'aaaaaaaaaaaa' },
    });
    expect(findLowCoverageSessions(db, traceDb, later)).toEqual([]);
  });

  it('leaves sessions older than the lookback to the pass that saw them', () => {
    const { db, traceDb, team } = fixture();
    ingestTraceEvents(traceDb, team.id, 'ryder', session('eeeeeeeeeeee', 1, 10, 1));
    expect(findLowCoverageSessions(db, traceDb, Date.now() + 30 * 24 * H)).toEqual([]);
  });
});
