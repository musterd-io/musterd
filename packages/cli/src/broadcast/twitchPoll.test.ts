import type { OpenPoll, PollMeta } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { makeTally, parseVote, pollLines, resultLine, startPollHandler } from './twitchPoll.js';

const POLL: OpenPoll = {
  id: '01M6POLL0000000000000000AA',
  question: 'What should team revive work on next?',
  options: [
    'The director camera for /broadcast',
    'Viewers ask the team questions',
    'Cloud accounts console',
  ],
  minutes: 5,
  opened_by: 'nick',
  opened_at: 1_000,
  closes_at: 301_000,
  counts: [0, 0, 0],
  voters: 0,
  post_failed: false,
};

const closed = (over: Partial<Extract<PollMeta, { state: 'closed' }>> = {}) =>
  ({
    state: 'closed',
    id: POLL.id,
    question: POLL.question,
    options: POLL.options,
    opened_by: 'nick',
    opened_at: POLL.opened_at,
    closes_at: POLL.closes_at,
    counts: [15, 25, 8],
    voters: 48,
    end: 'deadline',
    winners: [1],
    closed_at: 301_000,
    ...over,
  }) as Extract<PollMeta, { state: 'closed' }>;

describe('parseVote (ADR 807)', () => {
  it('takes !vote N, any case, and nothing else', () => {
    expect(parseVote('!vote 2', 3)).toBe(1);
    expect(parseVote('  !VOTE 3 ', 3)).toBe(2);
    expect(parseVote('2', 3)).toBeNull();
    expect(parseVote('!vote 4', 3)).toBeNull();
    expect(parseVote('!vote 0', 3)).toBeNull();
    expect(parseVote('!vote 2 please', 3)).toBeNull();
    expect(parseVote('!vote two', 3)).toBeNull();
  });
});

describe('makeTally', () => {
  it("counts each viewer's latest vote once, and drops one inside 2 s", () => {
    let t = 0;
    const tally = makeTally(3, () => t);
    expect(tally.vote('u1', 0)).toBe(true);
    t = 1_000;
    expect(tally.vote('u1', 1)).toBe(false); // inside the gap: dropped, not queued
    t = 2_500;
    expect(tally.vote('u1', 1)).toBe(true); // a changed vote moves the count
    expect(tally.vote('u2', 1)).toBe(true);
    expect(tally.counts()).toEqual([0, 2, 0]);
    expect(tally.voters()).toBe(2);
  });
  it('seeds from the daemon after a restart and adds new voters on top', () => {
    const t = 10_000;
    const tally = makeTally(2, () => t);
    tally.seed([4, 1], 5);
    expect(tally.vote('new-viewer', 0)).toBe(true);
    expect(tally.counts()).toEqual([5, 1]);
    expect(tally.voters()).toBe(6);
  });
});

describe('the fixed lines', () => {
  it('opens with what the bot is, who asks, the options and how to vote', () => {
    const lines = pollLines(POLL);
    expect(lines[0]).toBe(
      "👋 I'm musterd's Twitch bot. nick wants to ask you: What should team revive work on next?",
    );
    expect(lines.join('\n')).toContain('1 · The director camera for /broadcast');
    expect(lines.at(-1)).toBe('Vote by typing !vote 1, !vote 2 or !vote 3 — 5 minutes.');
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(500);
  });
  it('splits a long poll so no line passes 500 characters', () => {
    const long = {
      ...POLL,
      question: 'Q'.repeat(200),
      options: ['o'.repeat(80), 'p'.repeat(80), 'q'.repeat(80), 'r'.repeat(80)],
    };
    for (const l of pollLines(long)) expect(l.length).toBeLessThanOrEqual(500);
  });
  it('says each outcome in one sentence', () => {
    expect(resultLine(closed())).toBe(
      '🗳️ Poll closed — 48 votes. Winner: 2 · Viewers ask the team questions (52%). Thanks for voting!',
    );
    expect(resultLine(closed({ winners: [0, 1], counts: [20, 20, 8] }))).toBe(
      '🗳️ Poll closed — 48 votes. It’s a tie: 1 · The director camera for /broadcast and 2 · Viewers ask the team questions. Thanks for voting!',
    );
    expect(resultLine(closed({ winners: [], counts: [0, 0, 0], voters: 0 }))).toBe(
      '🗳️ Poll closed with no votes. Thanks for watching!',
    );
    expect(resultLine(closed({ end: 'cancelled', winners: [] }))).toBe(
      '🗳️ nick cancelled the poll.',
    );
    expect(resultLine(closed({ end: 'interrupted', winners: [] }))).toBe(
      '🗳️ The poll ended when the stream dropped — 48 votes counted.',
    );
  });
});

describe('startPollHandler', () => {
  function rig(opts: { postOk?: boolean } = {}) {
    const posted: string[] = [];
    const reports: { token: string; counts: number[] }[] = [];
    const logs: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const deps = {
      poll: POLL,
      post: async (line: string) => {
        if (posted.length === 1) await gate; // hold the second open line in flight
        posted.push(line);
        return opts.postOk ?? true;
      },
      report: async (token: string, c: { counts: number[] }) => {
        reports.push({ token, counts: c.counts });
        return 'ok' as const;
      },
      log: (l: string) => logs.push(l),
      now: () => 10_000,
    };
    return { deps, posted, reports, logs, release };
  }

  it('posts the result once, after the poll’s own lines, even when it closes mid-post', async () => {
    const r = rig();
    const h = startPollHandler(r.deps);
    const announcing = h.announce();
    const closing = h.close(closed());
    r.release();
    await Promise.all([announcing, closing]);
    await h.close(closed());
    expect(r.posted.at(-1)).toContain('Poll closed');
    expect(r.posted.filter((l) => l.includes('Poll closed'))).toHaveLength(1);
    expect(r.posted.indexOf(r.posted.at(-1)!)).toBe(pollLines(POLL).length);
  });

  it('keeps counting when Twitch refuses a post, says so once, and reports it', async () => {
    const r = rig({ postOk: false });
    const h = startPollHandler(r.deps);
    r.release();
    await h.announce();
    h.onChat('u1', '!vote 2');
    h.onChat('u2', 'hello chat');
    await h.flush('mspoll_a');
    expect(r.reports).toEqual([{ token: 'mspoll_a', counts: [0, 1, 0] }]);
    expect(r.logs.filter((l) => l.includes('post refused'))).toHaveLength(1);
  });

  it('logs no vote, viewer or token', async () => {
    const r = rig();
    const h = startPollHandler(r.deps);
    r.release();
    await h.announce();
    h.onChat('viewer-123', '!vote 1');
    await h.flush('mspoll_secret');
    const all = r.logs.join('\n');
    expect(all).not.toContain('viewer-123');
    expect(all).not.toContain('mspoll_secret');
    expect(all).not.toContain('!vote');
  });
});
