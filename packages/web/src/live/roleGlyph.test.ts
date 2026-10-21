import { describe, expect, it } from 'vitest';

import { roleGlyph } from './roleGlyph';

describe('roleGlyph', () => {
  it('draws every role in the library', () => {
    for (const role of [
      'admin',
      'courier',
      'designer',
      'engineer',
      'founder',
      'observer',
      'planner',
      'platform',
      'comms',
      'product-communications',
      'researcher',
      'security',
      'steward',
    ]) {
      expect(roleGlyph(role), role).toMatch(/^<svg viewBox="0 0 11 11" aria-hidden="true">.+<\/svg>$/);
    }
  });

  it('keeps the plain tag for a role it has no drawing for', () => {
    expect(roleGlyph('probe')).toBeNull();
    expect(roleGlyph('toString')).toBeNull();
  });

  it('reads the id loosely', () => {
    expect(roleGlyph(' Engineer ')).not.toBeNull();
  });
});
