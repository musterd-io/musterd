import type { AppDelivery } from '@musterd/protocol/app-channel';
import { describe, expect, it } from 'vitest';
import {
  ADVISORY_CATEGORY,
  gateBeforeNonce,
  LOCK_SCREEN_FALLBACK_TEXT,
  noticeFor,
  QUESTION_OPTIONS_CATEGORY_PREFIX,
  QUESTION_REPLY_CATEGORY,
  refusalLine,
  staleNotice,
  unverifiedNotice,
  waitingLine,
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

  it('gives a question its options and Reply, never approve or decline, once the key is enrolled', () => {
    const question = (options?: { label: string }[]) =>
      ask({
        ask: {
          ...(ask() as AppDelivery & { kind: 'ask' }).ask,
          question: {
            text: 'Which branch?',
            ...(options ? { options } : {}),
            blocking: false,
            audience: 'addressee',
            inferred: false,
          },
          interruption: 'passive',
        },
      });
    const shown = noticeFor(question([{ label: 'main' }]), 'fresh', 5_000, now, true);
    expect(shown).toEqual({
      title: 'musterd',
      body: 'Which branch?',
      subtitle: 'Press and hold to answer',
      category: `${QUESTION_OPTIONS_CATEGORY_PREFIX}nonce-1`,
      sound: false,
    });
    expect(noticeFor(question(), 'fresh', 5_000, now, true).category).toBe(QUESTION_REPLY_CATEGORY);
    expect(noticeFor(question(), 'fresh', 5_000, now).category).toBeUndefined();
    expect(noticeFor(question(), 'fresh', 5_000, now).subtitle).toBe('Open musterd to answer');
  });

  it('gives an advisory ask its actions and says to press and hold, with a count when more wait', () => {
    const notice = noticeFor({ ...ask(), waiting: 2 }, 'fresh', 5_000, now);
    expect(notice).toEqual({
      title: 'musterd',
      body: 'Ship it?',
      subtitle: 'Press and hold to answer · 2 more waiting',
      category: ADVISORY_CATEGORY,
      sound: true,
    });
    expect(noticeFor(ask(), 'fresh', 5_000, now).subtitle).toBe('Press and hold to answer');
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
    expect(noticeFor(empty, 'fresh', 5_000, now).body).toBe(LOCK_SCREEN_FALLBACK_TEXT);
    expect(unverifiedNotice().body).toBe('New ask — open musterd to see it.');
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

describe('refusalLine', () => {
  const now = 100 * 3_600_000;
  it('counts the last 24 hours and names each reason once', () => {
    expect(
      refusalLine(
        [
          { reason: 'fetch', at: now - 1_000 },
          { reason: 'timeout', at: now - 2_000 },
          { reason: 'fetch', at: now - 3_000 },
          { reason: 'check', at: now - 25 * 3_600_000 },
        ],
        now,
      ),
    ).toBe('Diagnostics: 3 lock-screen checks failed today (fetch, timeout)');
  });

  it('says nothing when there were none today', () => {
    expect(refusalLine([], now)).toBeNull();
    expect(refusalLine([{ reason: 'check', at: now - 30 * 3_600_000 }], now)).toBeNull();
  });
});

describe('a seat waiting on a question (ADR 806)', () => {
  const NOW = 1_800_000_000_000;
  it('names the person, or the team, and how long', () => {
    expect(waitingLine({ to: 'nick', since: NOW - 42 * 60_000 }, NOW)).toBe(
      'Waiting on nick · 42m',
    );
    expect(waitingLine({ to: null, since: NOW - 10_000 }, NOW)).toBe('Waiting on the team · now');
    expect(waitingLine({ to: 'nick', since: NOW - 3 * 3_600_000 }, NOW)).toBe(
      'Waiting on nick · 3h',
    );
    expect(waitingLine({ to: 'nick', since: NOW - 2 * 86_400_000 }, NOW)).toBe(
      'Waiting on nick · 2d',
    );
    expect(waitingLine({ to: 'nick', since: NOW + 5_000 }, NOW)).toBe('Waiting on nick · now');
  });
});
