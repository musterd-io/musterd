import { describe, expect, it } from 'vitest';
import {
  disputeAnswerAck,
  disputeOf,
  isReviewDispute,
  tiebreakNotice,
  type DisputeMeta,
} from './dispute.js';

describe('dispute stamp (ADR 505)', () => {
  it('reads a server stamp back, keeping only the named fields', () => {
    const got = disputeOf({ dispute: { via: 'review', lane: 'L1', ask: 'A1', extra: 1 } });
    expect(got).toEqual<DisputeMeta>({ via: 'review', lane: 'L1', ask: 'A1' });
  });

  it('is null for no meta, no stamp, or an unknown via — an older daemon never throws here', () => {
    expect(disputeOf(null)).toBeNull();
    expect(disputeOf({})).toBeNull();
    expect(disputeOf({ dispute: 'review' })).toBeNull();
    expect(disputeOf({ dispute: { via: 'rumour' } })).toBeNull();
  });

  it('a review rejection is a directed decline stamped via:review — nothing else', () => {
    const stamp = { dispute: { via: 'review', lane: 'L1' } };
    expect(isReviewDispute('decline', true, stamp)).toBe(true);
    // An answer is not an obligation (ADR 429) unless the stamp says it opened a dispute.
    expect(isReviewDispute('decline', true, {})).toBe(false);
    // A team-addressed decline is nobody's to answer.
    expect(isReviewDispute('decline', false, stamp)).toBe(false);
    // `challenge` is already in the obligation set; it needs no second door.
    expect(isReviewDispute('challenge', true, { dispute: { via: 'challenge' } })).toBe(false);
    expect(isReviewDispute('accept', true, stamp)).toBe(false);
  });
});

describe('the owner answer ack — one text for every surface', () => {
  it('names the lane in every variant, so a renderer may show the guidance alone', () => {
    const conceded = disputeAnswerAck({ lane: 'L1', verdict: 'conceded' });
    expect(conceded.lane).toBe('L1');
    expect(conceded.guidance).toMatch(/^Lane L1: concession recorded/);
    const held = disputeAnswerAck({
      lane: 'L1',
      verdict: 'held',
      tiebreak: { reviewer: 'bo', grade: 'cross_family' },
    });
    expect(held.guidance).toContain('awaiting_acceptance');
    expect(held.guidance).toContain('bo (cross_family)');
    const stranded = disputeAnswerAck({ lane: 'L1', verdict: 'held', tiebreak: null });
    expect(stranded.guidance).toContain('no second reviewer');
    expect(stranded.guidance).toContain('stays active');
  });

  it('the tiebreak notice tells the second reviewer what they are judging and which verb is which', () => {
    const n = tiebreakNotice('ada', 'nick');
    expect(n).toContain('ada rejected');
    expect(n).toContain('nick HELD');
    expect(n).toContain('`accept` if the hold stands');
  });
});
