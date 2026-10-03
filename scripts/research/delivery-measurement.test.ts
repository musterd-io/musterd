import { describe, expect, it } from 'vitest';
import {
  latencyByRail,
  refusalsBySeat,
  render,
  summarize,
  verdict,
  type RaisedRow,
  type RefusedRow,
} from './delivery-measurement.js';

/**
 * The §5 instrument (lane 01M3TAKT16). Its own acceptance criterion is that the verdict CAN COME
 * OUT EITHER WAY from the numbers: a window where every act is raised inside a boundary and no
 * probe is refused reads clean; a window of deaf seats or slow rails reads HOLD. A read that
 * always says HOLD would never let the deferral shrink; one that always says clean would shrink it
 * on a rail that reaches nobody.
 */
const raised = (
  ts: number,
  target: string,
  act: string,
  rail: string,
  created: number,
): RaisedRow => ({
  ts,
  target,
  detail: JSON.stringify({ act, rail, count: 1 }),
  act_created_at: created,
});
const refused = (ts: number, actor: string, detail: Record<string, unknown>): RefusedRow => ({
  ts,
  actor,
  detail: JSON.stringify(detail),
});

describe('the verdict can come out either way', () => {
  it('reads clean when every act is first-raised inside 30s and nobody is refused', () => {
    const rows = [
      raised(10_000, 'ada', 'a1', 'claude-code', 0),
      raised(12_000, 'lin', 'a2', 'claude-code', 5_000),
      raised(90_000, 'ada', 'a1', 'claude-code', 0), // a repeat raise of a1 — not a second act
    ];
    const s = summarize(rows, []);
    expect(s.acts).toBe(2);
    expect(s.rails[0]).toMatchObject({ rail: 'claude-code', acts: 2, under30s: 1 });
    expect(s.verdict.hold).toBe(false);
  });

  it('holds when refusals exceed a quarter of raises', () => {
    const rows = [raised(10_000, 'ada', 'a1', 'claude-code', 0)];
    const s = summarize(rows, [refused(1, 'ada', { lease: 'dead' })]);
    expect(s.verdict.hold).toBe(true);
    expect(s.verdict.why[0]).toMatch(/refusals are 100% of raises/);
  });

  it('holds on a rail whose p95 is over 30s with fewer than 80% under 30s', () => {
    const rows = [
      raised(10_000, 'ada', 'a1', 'grok', 0),
      raised(600_000, 'ada', 'a2', 'grok', 0),
      raised(700_000, 'ada', 'a3', 'grok', 0),
    ];
    const v = verdict(latencyByRail(rows).rails, rows.length, 0);
    expect(v.hold).toBe(true);
    expect(v.why[0]).toMatch(/^grok: p95/);
  });

  it('holds on an empty window rather than reading an absence as a pass', () => {
    expect(summarize([], []).verdict.hold).toBe(true);
  });
});

describe('latency is to the FIRST raise of each act, per rail', () => {
  it('takes the earliest raise and buckets it', () => {
    const rows = [
      raised(400_000, 'ada', 'a1', 'claude-code', 0), // a later re-raise listed first
      raised(20_000, 'ada', 'a1', 'claude-code', 0),
      raised(4_000_000, 'lin', 'a2', 'opencode', 0),
    ];
    const { rails } = latencyByRail(rows);
    const cc = rails.find((r) => r.rail === 'claude-code')!;
    expect(cc.p50Ms).toBe(20_000);
    expect(cc.buckets['<30s']).toBe(1);
    const oc = rails.find((r) => r.rail === 'opencode')!;
    expect(oc.buckets['>1h']).toBe(1);
  });

  it('skips an act whose message row is gone and counts an unparseable detail', () => {
    const gone: RaisedRow = { ts: 5, target: 'ada', detail: '{"act":"x"}', act_created_at: null };
    const bad: RaisedRow = { ts: 5, target: 'ada', detail: '{nope', act_created_at: 1 };
    const r = latencyByRail([gone, bad]);
    expect(r.rails).toEqual([]);
    expect(r.unparseable).toBe(1);
  });
});

describe('refusals are per seat, beside that seat’s raises, by lease state and reason', () => {
  it('counts both halves and keeps an unrecorded reason visible as such', () => {
    const seats = refusalsBySeat(
      [
        refused(1, 'ada', { lease: 'dead', reason: 'expired' }),
        refused(2, 'ada', { lease: 'dead' }),
        refused(3, 'lin', { lease: 'missing', reason: 'none_presented' }),
      ],
      [raised(9, 'ada', 'a1', 'claude-code', 0)],
    );
    expect(seats[0]).toMatchObject({
      seat: 'ada',
      refusals: 2,
      raises: 1,
      byLease: { dead: 2 },
      byReason: { expired: 1, '(unrecorded)': 1 },
    });
    expect(seats[1]).toMatchObject({ seat: 'lin', refusals: 1, raises: 0 });
  });
});

describe('render', () => {
  it('prints the verdict line and every rail', () => {
    const text = render('/tmp/x.db', 14, summarize([raised(10_000, 'ada', 'a1', 'grok', 0)], []));
    expect(text).toContain('grok');
    expect(text).toMatch(/VERDICT: the §5 criteria read clean/);
  });
});
