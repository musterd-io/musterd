import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { OpenPollReply } from '@musterd/protocol/wire';
import { PollCard } from './PollCard';
import { pollView, RESULT_SHOWN_MS, timeLeft } from './poll';

/** The /broadcast tally (ADR 807, lane 01M6ME5BFQ): the open poll, then its result for 15 s. */

const POLL = {
  id: '01M6POLL0000000000000000AA',
  question: 'What should team revive work on next?',
  options: ['The director camera', 'Viewers ask the team', 'Cloud accounts console'],
  minutes: 5,
  opened_by: 'nick',
  opened_at: 0,
  closes_at: 300_000,
  counts: [15, 25, 8],
  voters: 48,
  post_failed: false,
};

const open = (over: Partial<typeof POLL> = {}): OpenPollReply => ({
  live: true,
  poll: { ...POLL, ...over },
});

const closed = (over: Record<string, unknown> = {}): OpenPollReply => ({
  live: true,
  poll: null,
  last: {
    state: 'closed',
    id: POLL.id,
    question: POLL.question,
    options: POLL.options,
    opened_by: 'nick',
    opened_at: 0,
    closes_at: 300_000,
    counts: [15, 25, 8],
    voters: 48,
    end: 'deadline',
    winners: [1],
    closed_at: 300_000,
    ...over,
  } as NonNullable<OpenPollReply['last']>,
});

const html = (reply: OpenPollReply, now: number) => {
  const view = pollView(reply, now);
  return view ? renderToStaticMarkup(createElement(PollCard, { view })) : '';
};

describe('PollCard', () => {
  it('shows the question, a bar per option with its share, time left and the vote count', () => {
    const out = html(open(), 300_000 - 83_000);
    expect(out).toContain('What should team revive work on next?');
    expect(out.match(/<li class="bc-poll__row/g)).toHaveLength(3);
    expect(out).toContain('31%');
    expect(out).toContain('52%');
    expect(out).toContain('17%');
    expect(out).toContain('1:23 left');
    expect(out).toContain('48 votes · type !vote in chat');
    expect(out).toContain('!vote 2');
  });

  it('marks the leading option, both on a tie, and none before the first vote', () => {
    const lead = (o: string) => (o.match(/bc-poll__row is-lead/g) ?? []).length;
    expect(lead(html(open(), 1_000))).toBe(1);
    expect(lead(html(open({ counts: [20, 20, 8] }), 1_000))).toBe(2);
    expect(lead(html(open({ counts: [0, 0, 0], voters: 0 }), 1_000))).toBe(0);
    expect(html(open({ counts: [0, 0, 0], voters: 0 }), 1_000)).toContain('0 votes');
  });

  it('shows the winner for 15 s after the poll closes, then nothing', () => {
    expect(html(closed(), 300_000 + 1_000)).toContain('Winner: 2 · Viewers ask the team');
    expect(html(closed(), 301_000)).toContain('48 votes');
    expect(html(closed(), 301_000)).not.toContain('!vote');
    expect(html(closed(), 300_000 + RESULT_SHOWN_MS)).toBe('');
  });

  it('names both options on a tie, and says when nobody voted', () => {
    expect(html(closed({ winners: [0, 1], counts: [20, 20, 8] }), 301_000)).toContain(
      'It’s a tie: 1 · The director camera and 2 · Viewers ask the team',
    );
    expect(
      html(closed({ winners: [], counts: [0, 0, 0], voters: 0 }), 301_000),
    ).toContain('No votes this time');
  });

  it('shows nothing for a cancelled or interrupted poll, or with no poll at all', () => {
    expect(html(closed({ end: 'cancelled', winners: [] }), 301_000)).toBe('');
    expect(html(closed({ end: 'interrupted' }), 301_000)).toBe('');
    expect(html({ live: true, poll: null }, 0)).toBe('');
    expect(pollView(null, 0)).toBeNull();
  });

  it('never renders a voter, and carries a text equivalent without the ticking clock', () => {
    const out = html(open({ poll_token: 'mspoll_secret' } as never), 1_000);
    expect(out).not.toContain('mspoll_');
    expect(out).toContain('aria-live="polite"');
    expect(out).toMatch(/class="lc-sr"[^>]*>Poll: What should team revive work on next\?/);
  });

  it('counts the clock down in m:ss and never below zero', () => {
    expect(timeLeft(300_000, 0)).toBe('5:00');
    expect(timeLeft(300_000, 299_001)).toBe('0:01');
    expect(timeLeft(300_000, 400_000)).toBe('0:00');
  });
});
