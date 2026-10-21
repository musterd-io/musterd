import { describe, expect, it } from 'vitest';

import { occupation } from './occupation';

describe('occupation', () => {
  it('turns a role id into a word a viewer knows', () => {
    expect(occupation('designer')).toBe('designer');
    expect(occupation('product-communications')).toBe('writer');
    expect(occupation('platform')).toBe('ops');
  });

  it('never shows a raw role id it has no word for', () => {
    expect(occupation('probe')).toBeNull();
    expect(occupation('worker')).toBeNull();
    expect(occupation('observer')).toBeNull();
    expect(occupation('toString')).toBeNull();
  });

  it('shows nothing for a member with no role', () => {
    expect(occupation('')).toBeNull();
    expect(occupation(null)).toBeNull();
    expect(occupation(undefined)).toBeNull();
  });

  it('reads the id loosely', () => {
    expect(occupation(' Security ')).toBe('security');
  });
});
