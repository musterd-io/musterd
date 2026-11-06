import { describe, expect, it } from 'vitest';
import { handbackPath } from './handback.js';
import { safeReturnPath } from './returnpath.js';

const STATE = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eHF1dXg';
const GOOD = handbackPath({ aud: 'https://musterd.test', team: 'acme', state: STATE });

describe('safeReturnPath', () => {
  it('keeps the listed paths and turns anything else into /', () => {
    expect(safeReturnPath('/account')).toBe('/account');
    expect(safeReturnPath('//evil.test')).toBe('/');
    expect(safeReturnPath(null)).toBe('/');
  });

  it('keeps a canonical team hand-back (ADR 722 §1)', () => {
    expect(safeReturnPath(GOOD)).toBe(GOOD);
  });

  it('refuses a hand-back with an extra param, a reordered or encoded query, or a foreign host', () => {
    expect(safeReturnPath(`${GOOD}&return=%2F%2Fevil.test`)).toBe('/');
    expect(safeReturnPath(GOOD.replace('?', '%3F'))).toBe('/');
    expect(safeReturnPath(`//evil.test${GOOD}`)).toBe('/');
    const [, q] = GOOD.split('?');
    const reordered = `/handback?${q!.split('&').reverse().join('&')}`;
    expect(safeReturnPath(reordered)).toBe('/');
  });
});
