import { StylePolicySchema, resolveStyle } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { MemberRow } from './rows.js';
import { currentStyleEpochFor, styleEnvelopeFrom, styleResolver } from './style.js';

const policy = StylePolicySchema.parse({});

function human(name: string, prefs?: object): MemberRow {
  return {
    name,
    kind: 'human',
    observer: 0,
    left_at: null,
    style_prefs: prefs ? JSON.stringify(prefs) : null,
  } as unknown as MemberRow;
}

const agent = { name: 'fifty', kind: 'agent', observer: 0 } as const;

describe('currentStyleEpochFor — an agent row (lane 01M477S003)', () => {
  // The roster used to take `styleEnvelopeFrom(...).epoch`, which renders the whole block per row.
  // It now resolves the epoch alone; the two must never disagree (the roster's `style stale` and the
  // adapter's change line read the same epoch).
  const nick = human('nick', { length: 'concise' });
  const ada = human('ada', { bluntness: 'blunt' });

  it.each([
    ['the only human', [nick], null],
    ['the only human, driver unknown', [nick], 'nobody'],
    ['a named driver among several', [nick, ada], 'ada'],
    ['several humans, no driver', [nick, ada], null],
    ['several humans, driver not a human', [nick, ada], 'nobody'],
    ['no humans', [], null],
  ])('%s: same epoch as the full envelope', (_label, humans, driver) => {
    expect(currentStyleEpochFor(policy, humans, agent, driver)).toBe(
      styleEnvelopeFrom(policy, humans, driver).epoch,
    );
  });

  it('a human row still reads their own resolved style', () => {
    const nick = human('nick', { length: 'concise' });
    const ada = human('ada');
    expect(currentStyleEpochFor(policy, [nick, ada], nick, null)).not.toBe(
      currentStyleEpochFor(policy, [nick, ada], ada, null),
    );
  });
});

describe('styleResolver — one resolve per distinct input (lane 01M4GQ2G7B)', () => {
  // The roster resolved and hashed a style per row, twice per human row; run 28 put that at 4.8
  // points of the app core. The memo keys on the only inputs `resolveStyle` reads off a member.
  const nick = human('nick', { length: 'concise' });
  const ada = human('ada');

  it('agrees with resolveStyle for every input', () => {
    const resolve = styleResolver(policy);
    expect(resolve(nick)).toEqual(resolveStyle(policy, { length: 'concise' }));
    expect(resolve(ada)).toEqual(resolveStyle(policy));
    expect(resolve(undefined)).toEqual(resolveStyle(policy));
    expect(resolve(agent)).toEqual(resolveStyle(policy));
    expect(resolve(human('bad', undefined))).toEqual(resolveStyle(policy));
  });

  it('returns the cached result for a repeated input', () => {
    const resolve = styleResolver(policy);
    expect(resolve(nick)).toBe(resolve(human('nick-again', { length: 'concise' })));
    expect(resolve(agent)).toBe(resolve(undefined));
    expect(resolve(ada)).toBe(resolve(agent));
  });

  it('a malformed prefs blob reads as team defaults, as memberStylePrefs has it', () => {
    const broken = { ...human('x'), style_prefs: '{not json' } as MemberRow;
    expect(styleResolver(policy)(broken)).toEqual(resolveStyle(policy));
  });

  it('currentStyleEpochFor gives the same epoch with a shared resolver', () => {
    const resolve = styleResolver(policy);
    for (const driver of [null, 'ada', 'nick', 'nobody']) {
      expect(currentStyleEpochFor(policy, [nick, ada], agent, driver, resolve)).toBe(
        currentStyleEpochFor(policy, [nick, ada], agent, driver),
      );
    }
    expect(currentStyleEpochFor(policy, [nick, ada], nick, null, resolve)).toBe(
      resolveStyle(policy, { length: 'concise' }).epoch,
    );
  });
});
