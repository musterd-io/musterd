import { describe, expect, it } from 'vitest';
import { fill, TOUR_LANE_PREFIX, TOUR_LANE_TITLE, TOUR_REQUEST, TOUR_STEPS } from './tour.data.ts';

const BANNED = [
  ', not ',
  'not a ',
  'rather than',
  'instead of',
  "isn't",
  "it's not",
  'revolutionary',
  'magic',
  'supercharge',
  '10x',
  'seamless',
  'game-changing',
];

describe('tour script', () => {
  it('has the nine steps in order', () => {
    expect(TOUR_STEPS.map((s) => s.id)).toEqual([
      'what',
      'team',
      'give_work',
      'claims',
      'hands_back',
      'judge',
      'record',
      'add_seat',
      'next',
    ]);
  });
  it('waits on the event the spec names for each step', () => {
    const waits = Object.fromEntries(TOUR_STEPS.map((s) => [s.id, s.wait]));
    expect(waits).toEqual({
      what: 'continue',
      team: 'none',
      give_work: 'lane_opened',
      claims: 'lane_claimed',
      hands_back: 'awaiting_you',
      judge: 'verdict',
      record: 'none',
      add_seat: 'continue',
      next: 'none',
    });
  });
  it('hints the silent agent at 60s and 3m', () => {
    const claims = TOUR_STEPS.find((s) => s.id === 'claims')!;
    expect(claims.hints.map((h) => h.afterMs)).toEqual([60_000, 180_000]);
  });
  it('carries no contrast frame or hype word', () => {
    const all = [
      ...TOUR_STEPS.flatMap((s) => [s.title, ...s.body, ...s.hints.map((h) => h.text)]),
      TOUR_REQUEST,
    ]
      .join('\n')
      .toLowerCase();
    for (const w of BANNED) expect(all, w).not.toContain(w);
  });
  it('says "opened by", never "asked by", on the record step', () => {
    const rec = TOUR_STEPS.find((s) => s.id === 'record')!.body.join('\n');
    expect(rec).toContain('opened by');
    expect(rec.toLowerCase()).not.toContain('asked by');
  });
  it('names the person as acceptor in the request', () => {
    expect(TOUR_REQUEST).toContain("acceptor: '{you}'");
    expect(TOUR_REQUEST).toContain('{lane}');
  });
  it('fill replaces known placeholders and keeps unknown ones', () => {
    expect(fill('{you} and {agent} on {x}', { you: 'nick', agent: 'ada' })).toBe(
      'nick and ada on {x}',
    );
  });
  it('titles the lane with the tour prefix', () => {
    expect(TOUR_LANE_TITLE.startsWith(TOUR_LANE_PREFIX + ' ')).toBe(true);
  });
});
