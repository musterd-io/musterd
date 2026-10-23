import type { AppDelivery } from '@musterd/protocol/app-channel';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_CATEGORY,
  gateBeforeNonce,
  noticeFor,
  staleNotice,
  unverifiedNotice,
  UNVERIFIED_TEXT,
} from './notice';

const ask = (over: Partial<AppDelivery & { kind: 'ask' }> = {}): AppDelivery => ({
  v: 1,
  kind: 'ask',
  team: 'revive',
  binding: 'bind-1',
  ask: {
    id: 'ask-9f3k',
    from: 'slippy',
    from_kind: 'human',
    body: 'Ship it?',
    tier: 'standard',
    species: null,
    action_class: 'advisory',
    ts: 1,
  },
  token: 'tok',
  nonce: 'nonce-1',
  expires_at: 5_000,
  ...over,
});

describe('noticeFor', () => {
  const now = 1_000;

  it('gives an advisory ask its actions, and a count when more are waiting', () => {
    const notice = noticeFor({ ...ask(), waiting: 2 }, 'fresh', 5_000, now);
    expect(notice).toEqual({
      title: 'musterd',
      body: 'Ship it?',
      subtitle: '2 more waiting',
      category: ADVISORY_CATEGORY,
      sound: true,
    });
  });

  it('gives a listed act no actions', () => {
    const privileged = ask();
    if (privileged.kind !== 'ask') throw new Error('fixture');
    privileged.ask = { ...privileged.ask, action_class: 'privileged' };
    expect(noticeFor(privileged, 'fresh', 5_000, now).category).toBeUndefined();
    const withApproval = { ...ask(), approval: { approve: {}, reject: {} } } as AppDelivery;
    expect(noticeFor(withApproval, 'fresh', 5_000, now).category).toBeUndefined();
  });

  it('says one sentence for a replay and another for an empty body', () => {
    expect(noticeFor(ask(), 'replay', 5_000, now)).toEqual(staleNotice());
    const empty = ask();
    if (empty.kind !== 'ask') throw new Error('fixture');
    empty.ask = { ...empty.ask, body: '' };
    expect(noticeFor(empty, 'fresh', 5_000, now).body).toBe(UNVERIFIED_TEXT);
    expect(unverifiedNotice().body).toBe('an ask could not be verified');
  });

  it('does not consume a route that has already expired, or an empty body', () => {
    expect(gateBeforeNonce(ask(), 1_000, now)).toBe('stale');
    const empty = ask();
    if (empty.kind !== 'ask') throw new Error('fixture');
    empty.ask = { ...empty.ask, body: '' };
    expect(gateBeforeNonce(empty, 5_000, now)).toBe('unverified');
    expect(gateBeforeNonce(ask(), 5_000, now)).toBe('open');
  });

  it('words a held summary and a pairing', () => {
    expect(
      noticeFor(
        { v: 1, kind: 'held', team: 'revive', binding: 'bind-1', count: 1, until: 5_000 },
        'fresh',
        5_000,
        now,
      ).body,
    ).toBe('1 ask is held.');
    expect(
      noticeFor(
        { v: 1, kind: 'held', team: 'revive', binding: 'bind-1', count: 4, until: 5_000 },
        'fresh',
        5_000,
        now,
      ).body,
    ).toBe('4 asks are held.');
    expect(
      noticeFor(
        {
          v: 1,
          kind: 'paired',
          team: 'revive',
          binding: 'bind-1',
          member: 'nick',
          device_key_id: 'dev',
        },
        'fresh',
        5_000,
        now,
      ).body,
    ).toBe('Paired as nick.');
  });
});
