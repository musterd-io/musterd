import { describe, expect, it } from 'vitest';
import { shiftLabel } from './shift.wire.js';

describe('shiftLabel (ADR 792)', () => {
  const until = Date.parse('2026-11-04T02:00:00Z'); // 18:00 Pacific
  it('says on shift, until when, and the budget left', () => {
    expect(
      shiftLabel(
        { state: 'on', until, budget_left_usd: 4.1, stop_reason: null },
        'America/Los_Angeles',
      ),
    ).toBe('on shift until 18:00 · $4.10 left');
    expect(shiftLabel({ state: 'on', until: null, budget_left_usd: 10, stop_reason: null })).toBe(
      'on shift · $10.00 left',
    );
  });
  it('says why a shift is off or ending', () => {
    expect(
      shiftLabel({ state: 'off', until: null, budget_left_usd: 0, stop_reason: 'budget' }),
    ).toBe('off shift (budget spent)');
    expect(
      shiftLabel({ state: 'ending', until: null, budget_left_usd: 3, stop_reason: 'stopped' }),
    ).toBe('ending shift (stopped)');
  });
});
