import { describe, expect, it } from 'vitest';
import { pollEvent } from './format';

/** The poll record in the team's history (ADR 807 §9, lane 01M6ME5EPX): one clean line per act. */

const base = {
  id: '01M6POLL0000000000000000AA',
  question: 'What next?',
  options: ['Camera', 'Ask the team'],
  opened_by: 'nick',
  opened_at: 0,
  closes_at: 300_000,
};

describe('pollEvent', () => {
  it('reads the opening message as the question and who asked', () => {
    expect(
      pollEvent({ act: 'message', body: '[poll] …', meta: { poll: { ...base, state: 'open' } } }),
    ).toEqual({ title: 'Poll: What next?', state: 'asked by nick' });
  });

  it('reads the resolve as the question and how it came out', () => {
    const closed = (over: object) => ({
      act: 'resolve' as const,
      body: '[poll] …',
      meta: {
        poll: {
          ...base,
          state: 'closed',
          counts: [3, 1],
          voters: 4,
          end: 'deadline',
          winners: [0],
          closed_at: 300_000,
          ...over,
        },
      },
    });
    expect(pollEvent(closed({}))).toEqual({
      title: 'Poll closed: What next? → 1 · Camera',
      state: '4 votes',
    });
    expect(pollEvent(closed({ winners: [0, 1], counts: [2, 2] }))?.title).toBe(
      'Poll closed: What next? → a tie, 1 · Camera and 2 · Ask the team',
    );
    expect(pollEvent(closed({ end: 'cancelled', winners: [] }))).toEqual({
      title: 'Poll cancelled: What next?',
    });
    expect(pollEvent(closed({ end: 'interrupted' }))?.title).toBe(
      'Poll ended when the stream dropped: What next?',
    );
    expect(pollEvent(closed({ winners: [], counts: [0, 0], voters: 0 }))?.title).toBe(
      'Poll closed: What next? → no votes',
    );
  });

  it('ignores anything without a well-formed poll in its meta', () => {
    expect(pollEvent({ act: 'message', body: 'hi', meta: {} })).toBeNull();
    expect(pollEvent({ act: 'message', body: 'hi', meta: { poll: { state: 'open' } } })).toBeNull();
    expect(pollEvent({ act: 'message', body: 'hi' })).toBeNull();
  });
});
