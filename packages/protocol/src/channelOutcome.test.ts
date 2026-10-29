import { describe, expect, it } from 'vitest';
import { lastAskLine } from './channelOutcome.js';

const NOW = 1_800_000_000_000;

describe('lastAskLine (lane 01M64DSKT3)', () => {
  it('says nothing when no ask was routed to the channel yet', () => {
    expect(lastAskLine(null, NOW)).toBeNull();
    expect(lastAskLine(undefined, NOW)).toBeNull();
  });

  it('names a sent ask and its age', () => {
    expect(lastAskLine({ at: NOW - 20_000, ask: 'a', outcome: 'sent', reason: null }, NOW)).toBe(
      'last ask just now: sent',
    );
  });

  it('says why a skipped ask was not sent', () => {
    const at = NOW - 2 * 60_000;
    expect(lastAskLine({ at, ask: 'a', outcome: 'skipped', reason: 'present' }, NOW)).toBe(
      "last ask 2m ago: not sent — you were at your desk (Only while I'm away)",
    );
    expect(lastAskLine({ at, ask: 'a', outcome: 'skipped', reason: 'delivery_off' }, NOW)).toBe(
      'last ask 2m ago: not sent — delivery is off',
    );
    expect(
      lastAskLine({ at, ask: 'a', outcome: 'skipped', reason: 'below_tier_floor' }, NOW),
    ).toMatch(/tier floor/);
    expect(lastAskLine({ at, ask: 'a', outcome: 'skipped', reason: 'no_binding' }, NOW)).toMatch(
      /no phone is paired/,
    );
  });

  it('reads a relay failure as not sent, in hours and days as it ages', () => {
    expect(
      lastAskLine({ at: NOW - 3 * 3_600_000, ask: 'a', outcome: 'failed', reason: null }, NOW),
    ).toBe('last ask 3h ago: not sent — the relay was not connected');
    expect(
      lastAskLine(
        { at: NOW - 72 * 3_600_000, ask: 'a', outcome: 'skipped', reason: 'relay_not_connected' },
        NOW,
      ),
    ).toMatch(/^last ask 3d ago/);
  });
});
