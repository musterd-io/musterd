import { describe, expect, it, vi } from 'vitest';
import { claudePlan, claudeToken, parseClaude, resolveClaudeSignIn } from './claude.js';

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

  it('prefers limits, including a model window, and does not draw the same meter twice', () => {
    const read = parseClaude({
      five_hour: { utilization: 99, resets_at: 1_800_000_000 },
      seven_day: { utilization: 99, resets_at: 1_800_000_000 },
      seven_day_sonnet: { utilization: 3, resets_at: 1_800_000_000_000 },
      seven_day_opus: null,
      extra_usage: { utilization: 1 },
      limits: [
        { kind: 'session', percent: 10.4, resets_at: '2026-10-20T15:00:00.000000+00:00' },
        { kind: 'weekly_all', percent: 20, resets_at: 1_800_000_000 },
        {
          kind: 'weekly_scoped',
          percent: 4,
          resets_at: 1_800_000_000_000,
          scope: { model: { display_name: 'Fable' } },
        },
        {
          kind: 'weekly_scoped',
          percent: 80,
          scope: { model: { display_name: '<script>' } },
        },
      ],
    });
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.windows.map((window) => window.label)).toEqual([
      '5-hour window',
      'weekly window',
      'Fable weekly window',
    ]);
    expect(read.windows[0]?.used).toBe(10);
    expect(read.windows[2]?.resetsAt).toBe(1_800_000_000_000);
    expect(JSON.stringify(read)).not.toContain('sonnet');
    expect(JSON.stringify(read)).not.toContain('script');
    expect(JSON.stringify(read)).not.toContain('opus');
  });
});

describe('claudePlan', () => {
  it('names Max 20x, Pro, and Max when the tier is unknown', () => {
    expect(
      claudePlan({
        claudeAiOauth: {
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
          refreshToken: 'nope-refresh',
          accessToken: 'nope-access',
        },
      }),
    ).toBe('Claude Max 20x');
    expect(claudePlan({ claudeAiOauth: { subscriptionType: 'pro' } })).toBe('Claude Pro');
    expect(
      claudePlan({
        claudeAiOauth: { subscriptionType: 'max', rateLimitTier: 'default_claude_max_5x' },
      }),
    ).toBe('Claude Max 5x');
    const unknown = claudePlan({
      claudeAiOauth: {
        subscriptionType: 'max',
        rateLimitTier: 'secret_tier_name',
        refreshToken: 'nope',
      },
    });
    expect(unknown).toBe('Claude Max');
    expect(unknown).not.toContain('secret');
    expect(unknown).not.toContain('nope');
    expect(claudePlan({ claudeAiOauth: { subscriptionType: 'team' } })).toBe('Claude Team');
    expect(claudePlan({ claudeAiOauth: { subscriptionType: 'enterprise' } })).toBe(
      'Claude Enterprise',
    );
    expect(
      claudePlan({ claudeAiOauth: { subscriptionType: 'api', refreshToken: 'nope' } }),
    ).toBeNull();
  });
});

describe('resolveClaudeSignIn', () => {
  it('does not look the machine up when the caller passed null', async () => {
    const lookup = vi.fn(async () => ({ token: 'from-machine', plan: 'Claude Max' }));
    expect(
      await resolveClaudeSignIn(null, { CLAUDE_CODE_OAUTH_TOKEN: 'from-env' }, null, lookup),
    ).toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it('prefers the environment over the keychain and keeps a plan from the file', async () => {
    const lookup = vi.fn(async () => ({ token: 'from-machine', plan: 'Claude Pro' }));
    const signIn = await resolveClaudeSignIn(
      undefined,
      { CLAUDE_CODE_OAUTH_TOKEN: ' from-env ' },
      {
        claudeAiOauth: {
          accessToken: 'file-token',
          subscriptionType: 'max',
          rateLimitTier: 'default_claude_max_20x',
          refreshToken: 'nope',
        },
      },
      lookup,
    );
    expect(signIn).toEqual({ token: 'from-env', plan: 'Claude Max 20x' });
    expect(lookup).not.toHaveBeenCalled();
    expect(JSON.stringify(signIn)).not.toContain('nope');
    expect(JSON.stringify(signIn)).not.toContain('file-token');
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
