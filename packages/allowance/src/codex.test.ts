import { describe, expect, it } from 'vitest';
import { parseCodex, windowLabel } from './codex.js';

describe('windowLabel', () => {
  it('names the lengths Codex reports', () => {
    expect(windowLabel(18000)).toBe('5-hour window');
    expect(windowLabel(604800)).toBe('weekly window');
    expect(windowLabel(86400)).toBe('daily window');
    expect(windowLabel(3600)).toBe('hourly window');
    expect(windowLabel(90)).toBe('window');
  });
});

describe('parseCodex', () => {
  it('reads the two windows and drops the account identity', () => {
    const read = parseCodex({
      plan_type: 'plus',
      email: 'person@example.com',
      user_id: 'user-secret',
      account_id: 'acct-secret',
      rate_limit: {
        primary_window: {
          used_percent: 12.2,
          limit_window_seconds: 18000,
          reset_at: 1_800_000_000,
        },
        secondary_window: {
          used_percent: 40,
          limit_window_seconds: 604800,
          reset_at: 1_800_000_000,
        },
      },
    });
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.detail).toBe('plus');
    expect(read.windows.map((window) => window.label)).toEqual(['5-hour window', 'weekly window']);
    expect(read.windows[0]?.used).toBe(12);
    expect(read.windows[0]?.resetsAt).toBe(1_800_000_000_000);
    const text = JSON.stringify(read);
    expect(text).not.toContain('example.com');
    expect(text).not.toContain('user-secret');
    expect(text).not.toContain('acct-secret');
  });

  it('refuses a body with no windows', () => {
    expect(parseCodex({ rate_limit: {}, email: 'person@example.com' }).state).toBe('error');
  });
});
