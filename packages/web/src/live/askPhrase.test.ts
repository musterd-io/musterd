import { ASK_TIER_DEFAULTS, PROTOCOL_VERSION, type Envelope } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { applyTierClock, deriveAsks } from './asks';
import { askBanner, askChoices, askStatePhrase, choiceReply, SETTLED_MS } from './askPhrase';

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

  it('a lane-review ask names the lane, never the machine prefix', () => {
    const b = banner([
      ask('r', { body: '[lane] acceptance requested: "Roster fix" — Judge the LANDED OUTCOME…' }),
    ]);
    expect(b.mode === 'open' && b.reviewTitle).toBe('Roster fix');
    expect(b.mode === 'open' && b.question).toBe('');
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

describe('askChoices — an ask that is a choice says so (lane 01M511XNQC)', () => {
  // The consult nick approved without seeing its options (01M50H0C2E, 2026-10-15).
  const MASON = `Spend controls, unpriced floor (lane 01M4SB4D7R): I need a product decision from you. Spec is in PR #2661. Under spend_cap_usd today, codex and opencode wakes, and any wake that never reports cost, count for nothing. A team running only codex has no bound at all. The options:
A. Keep this as is and state it.
B. Block unpriced harnesses whenever a cap is set.
C. Add a separate key, unpriced_wake_cap, a count over 7 days on the same deny path. Unset keeps today's behaviour, 0 blocks unpriced harnesses explicitly, N allows N.
D. Price third-party tokens from a host table. ADR 364 says that needs its own ADR, and it still misses wakes that never report.
I recommend C. B makes an admin who only wants a dollar bound lose every codex seat. Which one? And if C, should the deny notice name both caps when both trip? I propose yes.`;

  it('finds every option of the consult that went wrong, and what the asker recommends', () => {
    const c = askChoices(MASON)!;
    expect(c.options.map((o) => o.key)).toEqual(['A', 'B', 'C', 'D']);
    expect(c.options[1]!.text).toBe('Block unpriced harnesses whenever a cap is set.');
    expect(c.options[2]!.text.startsWith('Add a separate key, unpriced_wake_cap')).toBe(true);
    expect(c.recommended).toBe('C');
    // The card shows only the question; the options are the buttons.
    expect(c.question.startsWith('Spend controls, unpriced floor')).toBe(true);
    expect(c.question.endsWith('The options:')).toBe(true);
    expect(c.question).not.toContain('Keep this as is');
  });

  it('reads `A)`, numbered and bulleted-letter styles', () => {
    expect(askChoices('Pick:\nA) red\nB) blue')!.options.map((o) => o.key)).toEqual(['A', 'B']);
    expect(askChoices('Which?\n1. ship now\n2. wait a day\n3. drop it')!.options.map((o) => o.key)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(askChoices('- (a) keep\n- (b) cut')!.options.map((o) => o.key)).toEqual(['A', 'B']);
  });

  it('is not a choice: a yes/no ask, a single option, or prose that only mentions "a."', () => {
    expect(askChoices('Can I merge #2661 now?')).toBeNull();
    expect(askChoices('Options:\nA. only this one')).toBeNull();
    expect(askChoices('I looked at plan a. It works. Merge?')).toBeNull();
    expect(askChoices('')).toBeNull();
  });

  it('keeps options in order and only a run that starts at A or 1', () => {
    expect(askChoices('Steps:\nB. second\nC. third')).toBeNull();
  });

  it('records a pick as the option itself, so the thread never needs interpreting', () => {
    const c = askChoices(MASON)!;
    expect(choiceReply(c.options[2]!)).toMatch(/^C — Add a separate key, unpriced_wake_cap/);
  });

  it('settles the rail on the option picked: "nick chose C"', () => {
    const picked = [
      ask('a'),
      env('r', 'accept', {
        from: 'nick',
        to: { kind: 'member', name: 'ryder' },
        meta: { in_reply_to: 'a' },
        body: 'C — Add a separate key',
        ts: NOW - 2_000,
      }),
    ];
    expect(banner(picked)).toMatchObject({ mode: 'settled', outcome: 'nick chose C ✓' });
  });
});
