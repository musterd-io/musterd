import { describe, expect, it, vi } from 'vitest';
import { claudeToken, parseClaude, resolveClaudeToken } from './claude.js';

describe('parseClaude', () => {
  it('reads the five-hour and weekly windows and skips overage', () => {
    const read = parseClaude({
      five_hour: { utilization: 10.4, resets_at: 1_800_000_000 },
      seven_day: { utilization: 20, resets_at: 1_800_000_000 },
      seven_day_sonnet: { utilization: 3, resets_at: 1_800_000_000_000 },
      seven_day_overage_included: { utilization: 99, resets_at: 1_800_000_000 },
      extra_usage: { utilization: 0.2 },
      iguana_necktie: { utilization: 4, resets_at: '2026-10-20T15:00:00.000000+00:00' },
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
    expect(JSON.stringify(read)).not.toContain('iguana');
  });

  it('reads a reset time Claude sends as a timestamp', () => {
    const read = parseClaude({
      five_hour: { utilization: 1, resets_at: '2026-10-20T15:00:00.000000+00:00' },
    });
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.windows[0]?.resetsAt).toBe(Date.UTC(2026, 9, 20, 15, 0));
  });
});

describe('resolveClaudeToken', () => {
  it('does not look the machine up when the caller passed null', async () => {
    const lookup = vi.fn(async () => 'from-machine');
    expect(
      await resolveClaudeToken(null, { CLAUDE_CODE_OAUTH_TOKEN: 'from-env' }, null, lookup),
    ).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('prefers the environment over the keychain', async () => {
    const lookup = vi.fn(async () => 'from-machine');
    expect(
      await resolveClaudeToken(undefined, { CLAUDE_CODE_OAUTH_TOKEN: ' from-env ' }, null, lookup),
    ).toBe('from-env');
    expect(lookup).not.toHaveBeenCalled();
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
