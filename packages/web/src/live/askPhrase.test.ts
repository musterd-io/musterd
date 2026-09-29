import { ASK_TIER_DEFAULTS, PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { applyTierClock, deriveAsks } from './asks';
import { askBanner, askStatePhrase, SETTLED_MS } from './askPhrase';

const MIN = 60_000;
const NOW = 100 * MIN;
function env(
  id: string,
  act: Envelope['act'],
  o: Partial<Envelope> & { meta?: Record<string, unknown> | null } = {},
): Envelope {
  return {
    id,
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'ryder',
    to: { kind: 'member', name: 'nick' },
    act,
    body: '',
    thread: null,
    meta: null,
    ts: NOW - MIN,
    ...o,
  } as Envelope;
}
const ask = (id: string, o: Partial<Envelope> & { meta?: Record<string, unknown> | null } = {}) =>
  env(id, 'ask', {
    body: 'may I merge the OAuth change?',
    meta: { species: 'approve', tier: 'standard' },
    ...o,
  });
const ctx = { you: 'nick', humans: new Set(['nick']) };
const banner = (envs: Envelope[], now = NOW) =>
  askBanner(applyTierClock(deriveAsks(envs), now), ctx, now);

describe('askStatePhrase — the §6 table', () => {
  it.each([
    ['stranded', 'nobody answered'],
    ['risk_accepted', 'went ahead after 5 min'],
    ['lapsed', 'expired'],
    ['held', 'holding until answered'],
    ['deferred', 'put off'],
    ['open', 'goes ahead in 5 min if unanswered'],
  ] as const)('%s → %s', (state, phrase) => {
    expect(askStatePhrase(state, 'standard')).toBe(phrase);
  });
  it('an open non-blocking ask says when it goes ahead', () => {
    expect(askStatePhrase('open', 'advisory')).toBe('goes ahead in 3 min if unanswered');
    expect(askStatePhrase('open', 'blocking')).toBe('holding until answered');
  });
});

describe('askBanner', () => {
  it('idle with nothing open', () => {
    expect(banner([])).toEqual({ mode: 'idle', more: 0 });
  });

  it('open: who is asking whom, the question on one line, the hold words and the clock', () => {
    const b = banner([ask('a', { body: 'may I merge the OAuth change?\nsecond line' })]);
    expect(b.mode).toBe('open');
    if (b.mode !== 'open') return;
    expect(b.lead.env.id).toBe('a');
    expect(b.who).toBe('ryder');
    expect(b.to).toBe('nick');
    expect(b.question).toBe('may I merge the OAuth change?');
    expect(b.hold).toBe('goes ahead in 4 min if unanswered');
    expect(b.clock).toBe('4:00');
    expect(b.more).toBe(0);
  });

  it('a held blocking ask reads as holding, with elapsed time', () => {
    const b = banner([
      ask('a', { ts: NOW - 20 * MIN, meta: { species: 'approve', tier: 'blocking' } }),
    ]);
    expect(b.mode).toBe('open');
    if (b.mode !== 'open') return;
    expect(b.hold).toBe('holding until answered');
    expect(b.clock).toBe('20:00');
  });

  it('a clock past an hour reads in hours and minutes', () => {
    const b = banner([
      ask('a', { ts: NOW - 331 * MIN, meta: { species: 'approve', tier: 'blocking' } }),
    ]);
    expect(b.mode === 'open' && b.clock).toBe('5h 31m');
  });

  it('settled within SETTLED_MS shows the outcome; older is idle (Review Focus 3)', () => {
    const answered = [
      ask('a'),
      env('r', 'accept', {
        from: 'nick',
        to: { kind: 'member', name: 'ryder' },
        meta: { in_reply_to: 'a' },
        ts: NOW - 2_000,
      }),
    ];
    const b = banner(answered);
    expect(b).toMatchObject({ mode: 'settled', outcome: 'nick approved ✓', who: 'ryder' });
    expect(banner(answered, NOW + SETTLED_MS + 1).mode).toBe('idle');
    const declined = [
      ask('b'),
      env('d', 'decline', {
        from: 'nick',
        to: { kind: 'member', name: 'ryder' },
        meta: { in_reply_to: 'b' },
        ts: NOW - 2_000,
      }),
    ];
    expect(banner(declined)).toMatchObject({ mode: 'settled', outcome: 'nick said no ✗' });
    const proceeded = [
      ask('c', { ts: NOW - 6 * MIN }),
      env('o', 'status_update', {
        meta: { ask_ref: 'c', ask_outcome: 'risk_accepted' },
        ts: NOW - 2_000,
      }),
    ];
    expect(banner(proceeded)).toMatchObject({ mode: 'settled', outcome: 'went ahead after 5 min' });
  });

  it('a lapsed ask is never a lead and never approved: idle, not "settled"', () => {
    const b = banner([ask('a', { ts: NOW - 60 * MIN })]);
    expect(b.mode).toBe('idle');
  });

  it('two open asks: one lead, the rest counted (Review Focus 5)', () => {
    const b = banner([ask('a', { ts: NOW - MIN }), ask('b', { ts: NOW - 2 * MIN })]);
    expect(b.mode).toBe('open');
    expect(b.more).toBe(1);
  });

  it('an agent-routed ask leads only when nothing waits on a human (Review Focus 2)', () => {
    const agent = ask('x', { to: { kind: 'member', name: 'stanley' } });
    const b = banner([agent, ask('h')]);
    expect(b.mode === 'open' && b.lead.env.id).toBe('h');
    const only = banner([agent]);
    expect(only.mode === 'open' && only.lead.env.id).toBe('x');
  });

  it('the tier timeout the phrase quotes is the protocol constant', () => {
    expect(ASK_TIER_DEFAULTS.standard.timeout_ms).toBe(5 * MIN);
  });
});
