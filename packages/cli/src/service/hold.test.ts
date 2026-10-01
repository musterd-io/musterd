import { describe, expect, it } from 'vitest';
import { MAX_HOLD_MS, describeHold, parseDuration, readHold, resolveHoldUntil } from './hold.js';

// 2026-10-01 18:00 local — every case is relative to this.
const now = new Date(2026, 9, 1, 18, 0, 0);
const at = (h: number, m: number, dayOffset = 0) =>
  new Date(2026, 9, 1 + dayOffset, h, m, 0).getTime();

describe('parseDuration', () => {
  it.each([
    ['2h', 2 * 3600_000],
    ['90m', 90 * 60_000],
    ['1h30m', 90 * 60_000],
  ])('%s', (s, ms) => expect(parseDuration(s)).toBe(ms));
  it.each(['', '2', 'h', '2d', '-1h', '0m'])('rejects %j', (s) =>
    expect(parseDuration(s)).toBeNull(),
  );
});

describe('resolveHoldUntil', () => {
  it('--until a later time today', () => {
    expect(resolveHoldUntil({ until: '21:30', now })).toBe(at(21, 30));
  });
  it('--until a time already past means tomorrow', () => {
    expect(resolveHoldUntil({ until: '01:00', now })).toBe(at(1, 0, 1));
  });
  it('--for a duration', () => {
    expect(resolveHoldUntil({ for: '2h', now })).toBe(now.getTime() + 2 * 3600_000);
  });
  it('caps a hold at 12h, so a typo cannot freeze the daemon for a week', () => {
    expect(() => resolveHoldUntil({ for: '13h', now })).toThrow(/12h/);
    // 17:00 is 23h away (tomorrow), not a short hold
    expect(() => resolveHoldUntil({ until: '17:00', now })).toThrow(/12h/);
    expect(resolveHoldUntil({ for: '12h', now })).toBe(now.getTime() + MAX_HOLD_MS);
  });
  it('rejects a malformed time or duration, and needs exactly one of them', () => {
    expect(() => resolveHoldUntil({ until: '9pm', now })).toThrow(/HH:MM/);
    expect(() => resolveHoldUntil({ until: '25:00', now })).toThrow(/HH:MM/);
    expect(() => resolveHoldUntil({ for: 'soon', now })).toThrow(/duration/);
    expect(() => resolveHoldUntil({ now })).toThrow(/--until or --for/);
    expect(() => resolveHoldUntil({ until: '21:00', for: '1h', now })).toThrow(/not both/);
  });
});

describe('readHold', () => {
  it('no stamp, or garbage, is no hold', () => {
    expect(readHold(null, now.getTime())).toEqual({ state: 'none' });
    expect(readHold('nonsense', now.getTime())).toEqual({ state: 'none' });
  });
  it('a future stamp is held; a past one is expired', () => {
    expect(readHold(String(at(21, 30)), now.getTime())).toEqual({
      state: 'held',
      until: at(21, 30),
    });
    expect(readHold(String(at(17, 0)), now.getTime())).toEqual({
      state: 'expired',
      until: at(17, 0),
    });
  });
});

describe('describeHold', () => {
  it('says the clock time and what is left', () => {
    expect(describeHold(at(19, 12), now.getTime())).toBe('until 19:12 (1h12m left)');
    expect(describeHold(at(18, 5), now.getTime())).toBe('until 18:05 (5m left)');
  });
});
