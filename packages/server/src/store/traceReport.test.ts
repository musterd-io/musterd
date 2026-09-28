import type { TraceEvent } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { openTraceDb } from '../db/traceDb.js';
import { openLane } from './lanes.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';
import { ingestTraceEvents } from './trace.js';
import { deriveTraceReport } from './traceReport.js';

const H = 60 * 60 * 1000;
const NOW = 1_790_400_000_000;

const ev = (over: Partial<TraceEvent>): TraceEvent => ({
  harness: 'claude-code',
  session_digest: 'aaaaaaaaaaaa',
  ts: NOW - H,
  kind: 'PostToolUse',
  ...over,
});
const usage = (seat: string, ts: number, tokens: Record<string, number>, digest = 'aaaaaaaaaaaa') =>
  ev({ kind: 'usage', ts, session_digest: digest, detail: { parser: 'claude-code@1', ...tokens } });

function fixture() {
  const db = openDb(':memory:');
  const traceDb = openTraceDb(':memory:');
  const team = createTeam(db, { slug: 'dawn' });
  addMember(db, team, { name: 'nick', kind: 'human', role: 'admin' });
  addMember(db, team, { name: 'ryder', kind: 'agent' });
  addMember(db, team, { name: 'izzo', kind: 'agent' });
  return { db, traceDb, team };
}

describe('deriveTraceReport (ADR 445 increment 4)', () => {
  it('coverage: R1 PostToolUse over R2 tool_uses, per harness, with the R2-rail session count', () => {
    const { db, traceDb, team } = fixture();
    ingestTraceEvents(traceDb, team.id, 'ryder', [
      ev({ tool_name: 'Bash' }),
      ev({ tool_name: 'Read' }),
      ev({ tool_name: 'Bash', outcome: 'error', kind: 'PostToolUseFailure' }),
      // a subagent's call: a fact in the hook count, but its sidechain transcript is not tailed
      ev({ tool_name: 'Grep', agent_id: 'sub-1' }),
      usage('ryder', NOW - H, { tool_uses: 4, input_tokens: 10, output_tokens: 5 }),
      ev({ harness: 'codex', session_digest: 'bbbbbbbbbbbb', tool_name: 'Bash' }),
      // a claude-code session with NO transcript rail: its hook calls count as a fact but must
      // not inflate the ratio — this is the 124% the live team read
      ev({ session_digest: 'ffffffffffff', tool_name: 'Bash' }),
      ev({ session_digest: 'ffffffffffff', tool_name: 'Read' }),
      ev({ session_digest: 'ffffffffffff', tool_name: 'Edit' }),
    ]);
    const r = deriveTraceReport(db, traceDb, team.id, ['ryder', 'izzo'], { days: 7, now: NOW });
    expect(r.coverage).toEqual([
      {
        harness: 'claude-code',
        sessions: 2,
        sessions_with_r2: 1,
        // the failed Bash counts: R2 counts a failed call too
        post_tool_use: 7,
        post_tool_use_r2: 3,
        r2_tool_uses: 4,
        coverage: 0.75,
      },
      {
        harness: 'codex',
        sessions: 1,
        sessions_with_r2: 0,
        post_tool_use: 1,
        post_tool_use_r2: 0,
        r2_tool_uses: 0,
        coverage: null,
      },
    ]);
    expect(r.tool_mix).toEqual([
      { harness: 'claude-code', tool: 'Bash', calls: 3, errors: 1, avg_duration_ms: null },
      { harness: 'claude-code', tool: 'Read', calls: 2, errors: 0, avg_duration_ms: null },
      { harness: 'codex', tool: 'Bash', calls: 1, errors: 0, avg_duration_ms: null },
      { harness: 'claude-code', tool: 'Edit', calls: 1, errors: 0, avg_duration_ms: null },
      { harness: 'claude-code', tool: 'Grep', calls: 1, errors: 0, avg_duration_ms: null },
    ]);
  });

  it('cost per lane: a usage row goes to the most recently claimed open lane; none → unattributed', () => {
    const { db, traceDb, team } = fixture();
    openLane(db, team.id, 'dawn', 'ryder', { title: 'lane A', claim: true }, NOW - 5 * H);
    openLane(db, team.id, 'dawn', 'ryder', { title: 'lane B', claim: true }, NOW - 2 * H);
    ingestTraceEvents(traceDb, team.id, 'ryder', [
      usage('ryder', NOW - 6 * H, { input_tokens: 1, output_tokens: 1 }), // before any claim
      usage('ryder', NOW - 4 * H, { input_tokens: 10, output_tokens: 20 }), // only A open
      usage('ryder', NOW - 1 * H, { input_tokens: 100, output_tokens: 200, cache_read_tokens: 7 }), // A and B open → B
    ]);
    ingestTraceEvents(traceDb, team.id, 'izzo', [
      usage('izzo', NOW - 1 * H, { input_tokens: 3, output_tokens: 3 }, 'cccccccccccc'), // izzo owns nothing
    ]);
    const r = deriveTraceReport(db, traceDb, team.id, ['ryder', 'izzo'], { days: 7, now: NOW });
    expect(
      r.lane_cost.map((l) => [
        l.title,
        l.turns,
        l.input_tokens,
        l.output_tokens,
        l.cache_read_tokens,
      ]),
    ).toEqual([
      ['lane B', 1, 100, 200, 7],
      ['lane A', 1, 10, 20, 0],
    ]);
    expect(r.unattributed).toEqual({
      turns: 2,
      input_tokens: 4,
      output_tokens: 4,
      cache_read_tokens: 0,
    });
  });

  it('cost per lane: a submitted lane stops collecting at its submit, not at its acceptor resolve', () => {
    const { db, traceDb, team } = fixture();
    const a = openLane(db, team.id, 'dawn', 'ryder', { title: 'lane A', claim: true }, NOW - 5 * H);
    // A merged and was submitted at -3h; its acceptor has not resolved it yet (resolved_at null).
    const submit = (laneId: string, ts: number, n: number) =>
      db
        .prepare(
          `INSERT INTO audit (id, team_id, ts, actor, action, target, result, detail, created_at)
           VALUES (?, ?, ?, 'ryder', 'lane.ready_for_review', ?, 'allow', '{}', ?)`,
        )
        .run(`rfr-${laneId}-${n}`, team.id, ts, laneId, ts);
    submit(a.id, NOW - 3 * H, 1);
    db.prepare(`UPDATE lanes SET state = 'awaiting_acceptance' WHERE id = ?`).run(a.id);
    // A second lane that was submitted, rejected back to claimed, and is being worked again: its
    // submit row is history, not a bound.
    const c = openLane(db, team.id, 'dawn', 'izzo', { title: 'lane C', claim: true }, NOW - 5 * H);
    submit(c.id, NOW - 4 * H, 1);
    ingestTraceEvents(traceDb, team.id, 'ryder', [
      usage('ryder', NOW - 4 * H, { input_tokens: 10, output_tokens: 20 }), // A, before submit
      usage('ryder', NOW - 2 * H, { input_tokens: 5, output_tokens: 5 }), // after A's submit → next work
    ]);
    ingestTraceEvents(traceDb, team.id, 'izzo', [
      usage('izzo', NOW - 1 * H, { input_tokens: 7, output_tokens: 7 }, 'cccccccccccc'), // C, resumed
    ]);
    const r = deriveTraceReport(db, traceDb, team.id, ['ryder', 'izzo'], { days: 7, now: NOW });
    expect(r.lane_cost.map((l) => [l.title, l.turns, l.input_tokens])).toEqual([
      ['lane A', 1, 10],
      ['lane C', 1, 7],
    ]);
    expect(r.unattributed.turns).toBe(1);
    expect(r.unattributed.input_tokens).toBe(5);
  });

  it('scopes to the seats given, and the window', () => {
    const { db, traceDb, team } = fixture();
    ingestTraceEvents(traceDb, team.id, 'ryder', [ev({ tool_name: 'Bash' })]);
    ingestTraceEvents(traceDb, team.id, 'izzo', [
      ev({ tool_name: 'Edit', session_digest: 'dddddddddddd' }),
      ev({ tool_name: 'Edit', session_digest: 'eeeeeeeeeeee', ts: NOW - 10 * 24 * H }),
    ]);
    const own = deriveTraceReport(db, traceDb, team.id, ['izzo'], { days: 7, now: NOW });
    expect(own.seats).toEqual(['izzo']);
    expect(own.tool_mix).toEqual([
      { harness: 'claude-code', tool: 'Edit', calls: 1, errors: 0, avg_duration_ms: null },
    ]);
    expect(own.coverage[0]!.sessions).toBe(1);
    const none = deriveTraceReport(db, traceDb, team.id, [], { days: 7, now: NOW });
    expect(none.coverage).toEqual([]);
    expect(none.tool_mix).toEqual([]);
  });
});
