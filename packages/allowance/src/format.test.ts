import { describe, expect, it } from 'vitest';
import { fillPercent, formatWhen, isLow, windowSentence } from './format.js';

describe('fill and low', () => {
  it('clamps the bar and marks a window low at 85%', () => {
    expect(fillPercent(1000, 10000)).toBe(10);
    expect(fillPercent(10000, 10000)).toBe(100);
    expect(fillPercent(12000, 10000)).toBe(100);
    expect(fillPercent(0, 0)).toBe(0);
    expect(isLow(8400, 10000)).toBe(false);
    expect(isLow(8500, 10000)).toBe(true);
    expect(isLow(12000, 10000)).toBe(true);
  });
});

describe('sentences', () => {
  const now = Date.UTC(2026, 9, 19, 12, 0);

  it('says what is left and when it comes back', () => {
    const resets = Date.UTC(2026, 9, 20, 15, 0);
    expect(formatWhen(resets, now, 'UTC')).toBe('tomorrow at 3:00 PM');
    expect(windowSentence(1000, 10000, 'characters', resets, now, 'UTC')).toBe(
      '9,000 characters left of 10,000. Back tomorrow at 3:00 PM.',
    );
  });

  it('says when a window is over, and when one character remains', () => {
    expect(windowSentence(10001, 10000, 'characters', null, now, 'UTC')).toBe(
      '1 character over 10,000.',
    );
    expect(windowSentence(9, 10, 'voice slots', null, now, 'UTC')).toBe('1 voice slot left of 10.');
    expect(windowSentence(10000, 10000, 'characters', null, now, 'UTC')).toBe(
      'None left of 10,000 characters.',
    );
  });

  it('names a weekday inside the week and a date after it', () => {
    expect(formatWhen(Date.UTC(2026, 9, 22, 15, 0), now, 'UTC')).toBe('Thursday at 3:00 PM');
    expect(formatWhen(Date.UTC(2026, 10, 3, 15, 0), now, 'UTC')).toBe('November 3');
    expect(formatWhen(now - 1000, now, 'UTC')).toBe('the reset time has passed');
  });
});
