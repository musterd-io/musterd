import { describe, expect, it } from 'vitest';
import { cardPlace } from './lanes.js';

describe('lane_update card (ADR 751)', () => {
  it('reads "x,y" as a place within the cell', () => {
    expect(cardPlace('0.25, 0.7')).toEqual({ x: 0.25, y: 0.7 });
  });

  it('refuses anything else, and says the shape', () => {
    for (const bad of ['0.5', '1.5,0.2', 'a,b', '0.1,0.2,0.3'])
      expect(() => cardPlace(bad)).toThrow(/pass "x,y", each 0\.\.1/);
  });
});
