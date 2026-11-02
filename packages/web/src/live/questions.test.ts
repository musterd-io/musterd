import type { Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { deriveAsks } from './asks';
import { askHeadline, askWhy, deriveQuestions, waitedLabel } from './questions';

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

describe('askHeadline / askWhy (lane 01M6EF2Z4B)', () => {
  const approval = (body: string) =>
    deriveAsks([
      env({
        act: 'ask',
        from: 'fifty',
        to: { kind: 'member', name: 'nick' },
        body,
        meta: { species: 'approve', tier: 'blocking' },
      }),
    ])[0]!;

  it('a long approval gets its first sentence as the headline and the rest as why', () => {
    const a = approval(
      'Redeploy Fly machine musterd-agent-delta-2 to pick up main at 3a27298. Build on the machine is pinned 2026-10-28, no autorefresh. Accept and I run it; decline and it waits.',
    );
    expect(askHeadline(a)).toBe('Redeploy Fly machine musterd-agent-delta-2 to pick up main at 3a27298.');
    expect(askWhy(a)).toBe(
      'Build on the machine is pinned 2026-10-28, no autorefresh. Accept and I run it; decline and it waits.',
    );
  });

  it('a short approval is the headline alone', () => {
    const a = approval('Restart the daemon?');
    expect(askHeadline(a)).toBe('Restart the daemon?');
    expect(askWhy(a)).toBeNull();
  });

  it('one run-on sentence is cut at a word and the whole body stays as why', () => {
    const body = `Redeploy ${'word '.repeat(40)}end`;
    const a = approval(body);
    expect(askHeadline(a).length).toBeLessThanOrEqual(97);
    expect(askHeadline(a).endsWith('\u2026')).toBe(true);
    expect(askWhy(a)).toBe(body);
  });

  it('a lane review reads as an acceptance question', () => {
    const a = approval('[lane] acceptance requested: "Joiner says last pulled" (server, 1 file)');
    expect(askHeadline(a)).toBe('Accept \u201cJoiner says last pulled\u201d?');
    expect(askWhy(a)).toBeNull();
  });
});
