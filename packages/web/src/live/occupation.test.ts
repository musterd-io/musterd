import { describe, expect, it } from 'vitest';

import { occupation } from './occupation';

describe('occupation', () => {
  it('turns a role id into a word a viewer knows', () => {
    expect(occupation(['designer'])).toBe('designer');
    expect(occupation(['product-communications'])).toBe('writer');
    expect(occupation(['platform'])).toBe('ops');
    expect(occupation(['steward'])).toBe('auditor');
    expect(occupation(['founder'])).toBe('founder');
  });

  it('gives admin no word: a permission, and "founder" would be false on most teams', () => {
    expect(occupation(['admin'])).toBeNull();
  });

  it('never shows a raw role id it has no word for', () => {
    expect(occupation(['probe'])).toBeNull();
    expect(occupation(['worker'])).toBeNull();
    expect(occupation(['observer'])).toBeNull();
    expect(occupation(['toString'])).toBeNull();
  });

  it('shows nothing for a member with no role', () => {
    expect(occupation([''])).toBeNull();
    expect(occupation([null])).toBeNull();
    expect(occupation([undefined])).toBeNull();
  });

  it('takes the first role that has a word, so admin + founder reads founder', () => {
    expect(occupation(['admin', 'founder'])).toBe('founder');
    expect(occupation(['designer', 'security'])).toBe('designer');
    expect(occupation(['admin'])).toBeNull();
    expect(occupation([])).toBeNull();
  });

  it('reads the id loosely', () => {
    expect(occupation([' Security '])).toBe('security');
  });
});
