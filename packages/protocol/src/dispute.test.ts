import { describe, expect, it } from 'vitest';
import {
  acceptedHandoffAck,
  builtOnLine,
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

  it('a built-on line names the dependency, how it closed and the acceptor note; the handoff ack quotes the note (ADR 505 §6)', () => {
    expect(
      builtOnLine({
        lane: 'L1',
        title: 'bo measured p95',
        state: 'done',
        merged: { pr: 42 },
        closed_by: 'cy',
        verified: true,
        note: 'p95 holds at 180ms',
      }),
    ).toBe('L1 "bo measured p95" — done, PR #42, closed by cy (accepted): "p95 holds at 180ms"');
    expect(
      builtOnLine({ lane: 'L2', title: 't', state: 'done', closed_by: 'bo', verified: false }),
    ).toBe('L2 "t" — done, closed by bo (unconfirmed)');
    const ack = acceptedHandoffAck({
      lane: 'L3',
      branch: 'feat/x',
      note: '7 seats remain on the old creds',
    });
    expect(ack).toContain('lane L3 (branch feat/x)');
    expect(ack).toContain('"7 seats remain on the old creds"');
    expect(ack).toContain('`challenge`');
  });

  it('the tiebreak notice tells the second reviewer what they are judging and which verb is which', () => {
    const n = tiebreakNotice('ada', 'nick');
    expect(n).toContain('ada rejected');
    expect(n).toContain('nick HELD');
    expect(n).toContain('`accept` if the hold stands');
  });
});
