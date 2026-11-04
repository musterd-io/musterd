import { describe, expect, it } from 'vitest';
import { AuthorityRelayRequestSchema } from './authorityRelay.js';
import { EnvelopeSchema } from './envelope.js';
import { OpenPollReplySchema, PollCountsSchema, PollMetaSchema, PollSpecSchema } from './poll.js';
import { POLL_LIMITS, winnersOf } from './poll.wire.js';
import { PROTOCOL_VERSION } from './version.js';

const spec = { question: 'What should team revive work on next?', options: ['A', 'B'], minutes: 5 };

describe('PollSpecSchema (ADR 807)', () => {
  it('takes 2–4 options and 1–15 minutes, 5 by default', () => {
    expect(PollSpecSchema.parse({ question: 'Q?', options: ['a', 'b'] }).minutes).toBe(
      POLL_LIMITS.defaultMinutes,
    );
    expect(PollSpecSchema.safeParse({ ...spec, options: ['a', 'b', 'c', 'd'] }).success).toBe(true);
    expect(PollSpecSchema.safeParse({ ...spec, minutes: 15 }).success).toBe(true);
  });
  it('refuses 1 or 5 options, 0 or 16 minutes, and an empty question or option', () => {
    for (const bad of [
      { ...spec, options: ['a'] },
      { ...spec, options: ['a', 'b', 'c', 'd', 'e'] },
      { ...spec, minutes: 0 },
      { ...spec, minutes: 16 },
      { ...spec, minutes: 2.5 },
      { ...spec, question: '   ' },
      { ...spec, options: ['a', ''] },
      { ...spec, extra: 1 },
    ]) {
      expect(PollSpecSchema.safeParse(bad).success).toBe(false);
    }
  });
});

describe('PollCountsSchema — only integers cross from chat (ADR 807 §1)', () => {
  const ok = {
    poll_id: '01M6POLL0000000000000000AA',
    counts: [3, 5],
    voters: 8,
    live: true,
    post_failed: false,
  };
  it('accepts counts, a voter count and the two observed booleans', () => {
    expect(PollCountsSchema.safeParse(ok).success).toBe(true);
  });
  it('refuses a non-integer, a negative, and any extra field', () => {
    expect(PollCountsSchema.safeParse({ ...ok, counts: [1.5, 2] }).success).toBe(false);
    expect(PollCountsSchema.safeParse({ ...ok, counts: [-1, 2] }).success).toBe(false);
    expect(PollCountsSchema.safeParse({ ...ok, voters: -1 }).success).toBe(false);
    expect(PollCountsSchema.safeParse({ ...ok, viewer: 'pixelpanda' }).success).toBe(false);
  });
  it('has no string field a chat message could ride in, besides the poll id', () => {
    const strings = Object.entries(PollCountsSchema.shape)
      .filter(
        ([, v]) =>
          v instanceof Object &&
          'safeParse' in v &&
          v.safeParse('a chat message could ride here').success,
      )
      .map(([k]) => k);
    expect(strings).toEqual(['poll_id']);
  });
});

describe('winnersOf', () => {
  it('names one winner, a tie, or none', () => {
    expect(winnersOf([1, 4, 2])).toEqual([1]);
    expect(winnersOf([3, 5, 5])).toEqual([1, 2]);
    expect(winnersOf([0, 0])).toEqual([]);
    expect(winnersOf([])).toEqual([]);
  });
});

describe('meta.poll on the record acts (ADR 807 §9)', () => {
  const base = {
    v: PROTOCOL_VERSION,
    id: '01M6POLLENV000000000000000',
    team: 'revive',
    from: 'nick',
    to: { kind: 'team' as const },
    body: 'Poll',
    ts: 1_793_835_000_000,
  };
  const open = {
    state: 'open',
    id: '01M6POLL0000000000000000AA',
    question: 'Q?',
    options: ['a', 'b'],
    opened_by: 'nick',
    opened_at: 1,
    closes_at: 2,
  };
  const closed = {
    ...open,
    state: 'closed',
    counts: [2, 1],
    voters: 3,
    end: 'deadline',
    winners: [0],
    closed_at: 3,
  };
  it('an open poll rides a message; a closed one rides a resolve', () => {
    expect(
      EnvelopeSchema.safeParse({ ...base, act: 'message', thread: null, meta: { poll: open } })
        .success,
    ).toBe(true);
    expect(
      EnvelopeSchema.safeParse({
        ...base,
        act: 'resolve',
        thread: '01M6POLLROOT00000000000000',
        meta: { poll: closed },
      }).success,
    ).toBe(true);
  });
  it('refuses a poll state on the wrong act, and a malformed record', () => {
    expect(
      EnvelopeSchema.safeParse({ ...base, act: 'resolve', thread: 'x', meta: { poll: open } })
        .success,
    ).toBe(false);
    expect(
      EnvelopeSchema.safeParse({ ...base, act: 'message', thread: null, meta: { poll: closed } })
        .success,
    ).toBe(false);
    expect(
      EnvelopeSchema.safeParse({
        ...base,
        act: 'message',
        thread: null,
        meta: { poll: { ...open, options: ['a'] } },
      }).success,
    ).toBe(false);
    expect(PollMetaSchema.safeParse({ ...closed, end: 'exploded' }).success).toBe(false);
  });
});

describe('the read and the relay', () => {
  it('GET /polls/open is { live, poll }, and poll_token is optional', () => {
    expect(OpenPollReplySchema.safeParse({ live: false, poll: null }).success).toBe(true);
    const poll = {
      ...spec,
      id: '01M6POLL0000000000000000AA',
      opened_by: 'nick',
      opened_at: 1,
      closes_at: 2,
      counts: [0, 0],
      voters: 0,
      post_failed: false,
    };
    expect(OpenPollReplySchema.safeParse({ live: true, poll }).success).toBe(true);
    expect(
      OpenPollReplySchema.safeParse({ live: true, poll: { ...poll, poll_token: 'mspoll_x' } })
        .success,
    ).toBe(true);
  });
  it('the authority relay carries poll.open with the spec and the proof', () => {
    expect(
      AuthorityRelayRequestSchema.safeParse({ op: 'poll.open', actor: 'nick', spec }).success,
    ).toBe(true);
  });
});
