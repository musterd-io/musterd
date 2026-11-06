/**
 * The instrument's opinions are in `classify`: what counts as a round, what counts as an accept,
 * and what is left out of the denominator. Each case below pins one of them, including the
 * tempting misreads (an unjudged close counted as an accept; a send-back without a re-submit
 * counted as round 2).
 */
import { describe, expect, it } from 'vitest';
import {
  areasOf,
  classify,
  report,
  tally,
  type AuditRow,
  type LaneRow,
} from './outcome-quality.ts';

const lane = (
  id: string,
  globs: string[] = ['packages/server/src/**'],
  areas?: string[],
): LaneRow => ({
  id,
  title: `lane ${id}`,
  surface_globs: JSON.stringify(globs),
  areas_json: areas ? JSON.stringify(areas) : null,
});
const ready = (ts: number, l: string): AuditRow => ({
  ts,
  action: 'lane.ready_for_review',
  actor: 'owner',
  detail: JSON.stringify({ lane: l, owner: 'owner', reviewer: 'acc' }),
});
const back = (ts: number, l: string, by = 'acc'): AuditRow => ({
  ts,
  action: 'lane.review_sent_back',
  actor: by,
  detail: JSON.stringify({ lane: l, reviewer: by, owner: 'owner' }),
});
const closed = (ts: number, l: string, reason: string, by = 'acc'): AuditRow => ({
  ts,
  action: 'lane.closed',
  actor: by,
  detail: JSON.stringify({ lane: l, closed_by: by, reason }),
});
const confirm = (ts: number, l: string): AuditRow => closed(ts, l, 'counterpart_confirm');
function kindOf(n: string | null): 'human' | 'agent' | 'unknown' {
  return n === 'nick' ? 'human' : n ? 'agent' : 'unknown';
}

describe('classify', () => {
  it('a confirm on the first submit is accepted first round', () => {
    const r = classify(lane('a'), [ready(1, 'a'), closed(2, 'a', 'counterpart_confirm')], kindOf)!;
    expect(r.outcome).toBe('accepted_first_round');
    expect(r.roundsToAccept).toBe(1);
    expect(r.judgedBy).toEqual(['agent']);
  });

  it('send-back, re-submit, confirm is two rounds', () => {
    const r = classify(
      lane('b'),
      [ready(1, 'b'), back(2, 'b', 'nick'), ready(3, 'b'), closed(4, 'b', 'counterpart_confirm')],
      kindOf,
    )!;
    expect(r.outcome).toBe('accepted_after_send_back');
    expect(r.roundsToAccept).toBe(2);
    expect(r.judgedBy).toEqual(['human', 'agent']);
  });

  it('a self-close is unjudged, never an accept', () => {
    const r = classify(lane('c'), [ready(1, 'c'), closed(2, 'c', 'self_close', 'owner')], kindOf)!;
    expect(r.outcome).toBe('unjudged');
    expect(r.roundsToAccept).toBeNull();
  });

  it('sent back then closed without a confirm is not an accept', () => {
    const r = classify(
      lane('d'),
      [ready(1, 'd'), back(2, 'd'), closed(3, 'd', 'owner_closed_early', 'owner')],
      kindOf,
    )!;
    expect(r.outcome).toBe('sent_back_then_closed_unjudged');
    expect(r.submits).toBe(1);
  });

  it('sent back and still open', () => {
    const r = classify(lane('e'), [ready(1, 'e'), back(2, 'e')], kindOf)!;
    expect(r.outcome).toBe('sent_back_still_open');
  });

  it('a lane never submitted is not in the population', () => {
    expect(classify(lane('f'), [closed(1, 'f', 'self_close')], kindOf)).toBeNull();
  });

  it('orders rows by time, not by arrival', () => {
    const r = classify(lane('g'), [closed(2, 'g', 'counterpart_confirm'), ready(1, 'g')], kindOf)!;
    expect(r.outcome).toBe('accepted_first_round');
  });
});

describe('areasOf', () => {
  it('declared areas win over scope', () => {
    const declared = { surface_globs: '["packages/web/**"]', areas_json: '["Design","docs"]' };
    expect(areasOf(declared)).toEqual(['design', 'docs']);
  });
  it('derives package, docs and top-level areas from scope', () => {
    const globs = ['packages/cli/src/**', 'docs/x.md', 'README.md', 'scripts/a.ts'];
    const surface_globs = JSON.stringify(globs);
    expect(areasOf({ surface_globs })).toEqual(['cli', 'docs', 'scripts']);
  });
  it('an empty scope is unscoped', () => {
    expect(areasOf({ surface_globs: '[]' })).toEqual(['unscoped']);
  });
});

describe('tally and report', () => {
  const lanes = [lane('a'), lane('b', ['packages/web/**']), lane('c'), lane('d', ['docs/**'])];
  const rows = new Map<string, AuditRow[]>([
    ['a', [ready(10, 'a'), closed(11, 'a', 'counterpart_confirm')]],
    ['b', [ready(20, 'b'), back(21, 'b', 'nick'), ready(22, 'b'), confirm(23, 'b')]],
    ['c', [ready(30, 'c'), closed(31, 'c', 'acceptance_exempt', 'owner')]],
    ['d', [ready(40, 'd'), back(41, 'd')]],
  ]);

  it('excludes unjudged lanes from the send-back denominator', () => {
    const r = report('t', null, lanes, rows, kindOf);
    expect(r.overall.lanes).toBe(4);
    expect(r.overall.judged).toBe(3);
    expect(r.overall.sendBackRate).toBeCloseTo(2 / 3);
    expect(r.overall.rounds).toEqual({ '1': 1, '2': 1 });
    expect(r.overall.meanRoundsToAccept).toBe(1.5);
    expect(r.closeReasonsUnjudged).toEqual({ acceptance_exempt: 1 });
  });

  it('splits by area and by who judged', () => {
    const r = report('t', null, lanes, rows, kindOf);
    expect(r.byArea['server']!.judged).toBe(1);
    expect(r.byArea['web']!.sendBackRate).toBe(1);
    expect(r.verdictsByJudge).toEqual({
      agent: { accepts: 2, sendBacks: 1 },
      human: { accepts: 0, sendBacks: 1 },
    });
    expect(r.sentBack.map((s) => s.lane)).toEqual(['b', 'd']);
  });

  it('--since filters on the first submit', () => {
    expect(report('t', 25, lanes, rows, kindOf).overall.lanes).toBe(2);
  });

  it('an empty population reports n/a, not zero', () => {
    expect(tally([]).sendBackRate).toBeNull();
  });
});
