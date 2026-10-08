import { StylePolicySchema } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { MemberRow } from './rows.js';
import { currentStyleEpochFor, styleEnvelopeFrom } from './style.js';

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
