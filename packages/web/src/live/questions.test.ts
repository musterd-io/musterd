import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { deriveAsks } from './asks';
import { deriveQuestions, waitedLabel, waitingOn } from './questions';

const T0 = 1_800_000_000_000;
let n = 0;
function env(over: Partial<Envelope> & Pick<Envelope, 'act' | 'from'>): Envelope {
  n += 1;
  return {
    v: 1,
    id: `e${n}`,
    team: 'revive',
    ts: T0 + n,
    to: { kind: 'team' },
    body: '',
    thread: null,
    meta: {},
    ...over,
  } as Envelope;
}
const question = (from: string, to: string, extra: Record<string, unknown> = {}) =>
  env({
    act: 'ask',
    from,
    to: { kind: 'member', name: to },
    body: 'Merge now or wait for CI?',
    meta: {
      species: 'consult',
      tier: 'advisory',
      question: { text: 'Merge now or wait for CI?', blocking: false, audience: 'addressee', inferred: false, ...extra },
    },
  });

describe('deriveQuestions (seats ask 1e)', () => {
  it("returns ryder's open question to nick, and drops it once an answer arrives", () => {
    const q = question('ryder', 'nick');
    expect(deriveQuestions([q], 'nick', T0 + 120_000).map((c) => c.asker)).toEqual(['ryder']);
    const answer = env({
      act: 'accept',
      from: 'nick',
      to: { kind: 'member', name: 'ryder' },
      meta: { in_reply_to: q.id, answer: { choice: 0 } },
    });
    expect(deriveQuestions([q, answer], 'nick', T0 + 120_000)).toEqual([]);
  });

  it('is not shown to someone else, unless it was put to the whole team', () => {
    expect(deriveQuestions([question('ryder', 'swetha')], 'nick', T0)).toEqual([]);
    expect(deriveQuestions([question('ryder', 'swetha', { audience: 'team' })], 'nick', T0)).toHaveLength(1);
  });

  it("drops a question its asker withdraws, and never shows one to its own asker", () => {
    const q = question('ryder', 'nick');
    const withdraw = env({ act: 'resolve', from: 'ryder', meta: { in_reply_to: q.id } });
    expect(deriveQuestions([q, withdraw], 'nick', T0)).toEqual([]);
    expect(deriveQuestions([question('nick', 'swetha', { audience: 'team' })], 'nick', T0)).toEqual([]);
  });

  it('is skipped by deriveAsks — one card per question, never both', () => {
    expect(deriveAsks([question('ryder', 'nick')])).toEqual([]);
  });

  it('reads waits the way the list prints them', () => {
    expect([30_000, 120_000, 3_600_000, 2 * 86_400_000].map(waitedLabel)).toEqual(['now', '2m', '1h', '2d']);
  });
});

describe('waitingOn — who each seat is waiting on (lane 01M6M6G228)', () => {
  it("names the person and the oldest open wait, whoever is reading", () => {
    const first = question('ryder', 'nick');
    const second = question('ryder', 'swetha');
    const w = waitingOn([first, second], T0 + 42 * 60_000);
    expect(w.get('ryder')).toEqual({ to: 'nick', waitedMs: T0 + 42 * 60_000 - first.ts });
  });
  it('forgets a question once it is answered or withdrawn', () => {
    const q = question('ryder', 'nick');
    const answer = env({ act: 'accept', from: 'nick', meta: { in_reply_to: q.id, answer: { choice: 0 } } });
    expect(waitingOn([q, answer], T0 + 60_000).has('ryder')).toBe(false);
    const q2 = question('dolly', 'nick');
    const withdraw = env({ act: 'resolve', from: 'dolly', meta: { in_reply_to: q2.id } });
    expect(waitingOn([q2, withdraw], T0 + 60_000).has('dolly')).toBe(false);
  });
  it('says the team for a question put to everyone', () => {
    const q = question('ryder', 'nick', { audience: 'team' });
    const team = { ...q, to: { kind: 'team' } } as Envelope;
    expect(waitingOn([team], T0 + 60_000).get('ryder')?.to).toBeNull();
  });
});
