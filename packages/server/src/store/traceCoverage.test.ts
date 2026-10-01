import type { TraceEvent } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { appendAudit } from './audit.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';
import { ingestTraceEvents } from './trace.js';
import { findLowCoverageSessions, TRACE_COVERAGE_QUIET_MS } from './traceCoverage.js';

let openStore: () => Promise<Driver>;
let openTrace: () => Promise<Driver>;

withDrivers('traceCoverage', (o, kind) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
    openTrace = () => openTestDriver(kind, { store: 'trace' });
  });

  const H = 60 * 60 * 1000;

  async function fixture() {
    const db = await openStore();
    const traceDb = await openTrace();
    const team = await createTeam(db, { slug: 'dawn' });
    await addMember(db, team, { name: 'ryder', kind: 'agent' });
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

  describe('findLowCoverageSessions (ADR 445 trace.coverage_low)', async () => {
    it('judges quiet two-rail sessions only, below 0.98, once per digest', async () => {
      const { db, traceDb, team } = await fixture();
      // received_at is stamped at ingest (Date.now()), so "now" is set relative to it.
      await ingestTraceEvents(traceDb, team.id, 'ryder', [
        ...session('aaaaaaaaaaaa', 9, 10, 1), // 0.9 → low
        ...session('bbbbbbbbbbbb', 99, 100, 1), // 0.99 → fine
        ...session('cccccccccccc', 11, 10, 1), // over 1 → not low
      ]);
      await ingestTraceEvents(traceDb, team.id, 'ryder', [
        // R1 only: no denominator, cannot tell — never judged
        { harness: 'grok', session_digest: 'dddddddddddd', ts: 1, kind: 'PostToolUse' },
      ]);
      const later = Date.now() + TRACE_COVERAGE_QUIET_MS + 1000;

      // still live: nothing judged yet
      expect(await findLowCoverageSessions(db, traceDb, Date.now())).toEqual([]);

      const found = await findLowCoverageSessions(db, traceDb, later);
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
      await appendAudit(db, team.id, {
        actor: null,
        action: 'trace.coverage_low',
        target: 'ryder',
        result: 'allow',
        detail: { session_digest: 'aaaaaaaaaaaa' },
      });
      expect(await findLowCoverageSessions(db, traceDb, later)).toEqual([]);
    });

    // Lane 01M3N78KVY: cursor's after-hooks fire beside `postToolUse` for one call; counting both
    // reads a session at 200% and hides a real miss. The after-rows count only when a session has no
    // `postToolUse` spelling at all.
    it('counts a cursor call once when postToolUse and an after-hook both fired', async () => {
      const { db, traceDb, team } = await fixture();
      const row = (digest: string, hook_event: string): TraceEvent => ({
        harness: 'cursor',
        session_digest: digest,
        ts: 1,
        kind: 'PostToolUse',
        tool_name: 'Shell',
        detail: { hook_event },
      });
      const usage = (digest: string, tool_uses: number): TraceEvent => ({
        harness: 'cursor',
        session_digest: digest,
        ts: 1,
        kind: 'usage',
        detail: { parser: 'cursor@1', tool_uses },
      });
      await ingestTraceEvents(traceDb, team.id, 'ryder', [
        // 9 calls, each fired twice: 18 rows over 10 transcript calls would read 1.8 and hide the miss
        ...Array.from({ length: 9 }, () => row('aaaaaaaaaaaa', 'postToolUse')),
        ...Array.from({ length: 9 }, () => row('aaaaaaaaaaaa', 'afterShellExecution')),
        usage('aaaaaaaaaaaa', 10),
        // after-hooks only: their 10 rows are the session's whole record → 10/10, fine
        ...Array.from({ length: 10 }, () => row('bbbbbbbbbbbb', 'afterShellExecution')),
        usage('bbbbbbbbbbbb', 10),
      ]);
      const found = await findLowCoverageSessions(
        db,
        traceDb,
        Date.now() + TRACE_COVERAGE_QUIET_MS + 1000,
      );
      expect(found).toEqual([
        {
          team_id: team.id,
          seat: 'ryder',
          harness: 'cursor',
          session_digest: 'aaaaaaaaaaaa',
          post_tool_use: 9,
          r2_tool_uses: 10,
          coverage: 0.9,
        },
      ]);
    });

    // Lane 01M3N8GF8D: cursor-agent re-emits `postToolUse` for one call id (wanderer 0e58c84e: one
    // Read fired 26 times, 144 rows over 106 ids). One call id is one call, however often it fires.
    it('counts a call id once however many times its hook fired', async () => {
      const { db, traceDb, team } = await fixture();
      const row = (tool_use_id: string): TraceEvent => ({
        harness: 'cursor',
        session_digest: 'aaaaaaaaaaaa',
        ts: 1,
        kind: 'PostToolUse',
        tool_name: 'Read',
        tool_use_id,
        detail: { hook_event: 'postToolUse' },
      });
      await ingestTraceEvents(traceDb, team.id, 'ryder', [
        // 9 distinct calls, one of them fired 12 times: 20 rows over 10 transcript calls hides 0.9
        ...Array.from({ length: 9 }, (_, i) => row(`call-${i}`)),
        ...Array.from({ length: 11 }, () => row('call-0')),
        {
          harness: 'cursor',
          session_digest: 'aaaaaaaaaaaa',
          ts: 1,
          kind: 'usage',
          detail: { parser: 'cursor@1', tool_uses: 10 },
        },
      ]);
      const found = await findLowCoverageSessions(
        db,
        traceDb,
        Date.now() + TRACE_COVERAGE_QUIET_MS + 1000,
      );
      expect(found.map((s) => [s.post_tool_use, s.coverage])).toEqual([[9, 0.9]]);
    });

    it('leaves sessions older than the lookback to the pass that saw them', async () => {
      const { db, traceDb, team } = await fixture();
      await ingestTraceEvents(traceDb, team.id, 'ryder', session('eeeeeeeeeeee', 1, 10, 1));
      expect(await findLowCoverageSessions(db, traceDb, Date.now() + 30 * 24 * H)).toEqual([]);
    });
  });
});
