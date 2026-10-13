import { describe, expect, it } from 'vitest';
import { walkTag } from './headline';

describe('walkTag — the verb over a walker (ADR 464 §3.2)', () => {
  it('a pin and a submit carry the lane title', () => {
    expect(walkTag('pin', 'Rotate keys')).toBe('finished Rotate keys');
    expect(walkTag('submit', null)).toBe('submitting a lane');
  });
  it.each([
    ['handoff', 'dolly', 'handing off → dolly'],
    ['help', 'izzo', 'asking for help'],
    ['steer', 'izzo', 'redirecting izzo'],
    ['steer', null, 'redirecting'],
    ['claim', 'Rotate the leaked keys', 'claiming Rotate the leaked keys'],
    ['claim', null, 'claiming a lane'],
  ] as const)('%s → %s', (kind, to, out) => expect(walkTag(kind, to)).toBe(out));
});
