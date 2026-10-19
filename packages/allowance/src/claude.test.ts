import { describe, expect, it } from 'vitest';
import { claudeToken, parseClaude } from './claude.js';

describe('parseClaude', () => {
  it('reads the five-hour and weekly windows and skips overage', () => {
    const read = parseClaude({
      five_hour: { utilization: 10.4, resets_at: 1_800_000_000 },
      seven_day: { utilization: 20, resets_at: 1_800_000_000 },
      seven_day_sonnet: { utilization: 3, resets_at: 1_800_000_000_000 },
      seven_day_overage_included: { utilization: 99, resets_at: 1_800_000_000 },
    });
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.windows.map((window) => window.label)).toEqual([
      '5-hour window',
      'weekly window',
      'weekly sonnet window',
    ]);
    expect(read.windows[0]?.used).toBe(10);
    expect(read.windows[2]?.resetsAt).toBe(1_800_000_000_000);
    expect(JSON.stringify(read)).not.toContain('overage');
  });
});

describe('claudeToken', () => {
  it('reads the access token and nothing else', () => {
    expect(
      claudeToken({
        claudeAiOauth: { accessToken: ' secret ', refreshToken: 'nope' },
      }),
    ).toBe('secret');
    expect(claudeToken({ claudeAiOauth: { refreshToken: 'nope' } })).toBeNull();
  });
});
