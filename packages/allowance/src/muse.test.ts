import { describe, expect, it } from 'vitest';
import { accountKey, museAccountKey } from './accountKey.js';
import { readBoard } from './board.js';
import { asMuse, interpretMuseRun, parseMuseText, parseMuseUsage } from './muse.js';
import { allowanceSnapshot } from './snapshot.js';

const RESET_MS = 1_700_000_100_000;
const WEEK_MS = 1_700_060_000_000;
const EMAIL = 'ada@example.com';
const TOKEN = 'secret-token-value';

function windowBody(used: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    allowance: {
      tier: 'internal-tier-id',
      window: { usedPercent: used, windowDurationMins: 300, resetsAtMs: RESET_MS },
      weekly: { usedPercent: 10, resetsAtMs: WEEK_MS },
    },
  };
}

describe('parseMuseUsage', () => {
  it('paints 65% left of the 5-hour window from usedPercent 35, and drops the tier', () => {
    const read = parseMuseUsage(windowBody(35));
    expect(read).toEqual({
      state: 'live',
      detail: null,
      windows: [
        {
          id: 'session',
          unit: 'percent',
          used: 35,
          limit: 100,
          resetsAt: RESET_MS,
          label: '5-hour window',
        },
        {
          id: 'weekly',
          unit: 'percent',
          used: 10,
          limit: 100,
          resetsAt: WEEK_MS,
          label: 'weekly window',
        },
      ],
    });
    expect(JSON.stringify(read)).not.toContain('internal-tier-id');
    if (read.state !== 'live') return;
    const key = museAccountKey({ user_email: EMAIL, access_token: TOKEN });
    const snapshot = allowanceSnapshot(
      {
        readAt: 1_700_000_000_000,
        timeZone: 'UTC',
        chosen: ['muse'],
        providers: [asMuse(read)],
      },
      [{ provider: 'muse', accountKey: key }],
    );
    expect(snapshot).toEqual({
      accounts: [
        {
          provider: 'muse',
          account: key,
          label: 'Muse',
          readAt: 1_700_000_000_000,
          windows: [
            { name: '5h', left: 0.65, resetsAt: RESET_MS, kind: 'percent' },
            { name: 'week', left: 0.9, resetsAt: WEEK_MS, kind: 'percent' },
          ],
        },
      ],
    });
    expect(JSON.stringify(snapshot)).not.toContain(EMAIL);
    expect(JSON.stringify(snapshot)).not.toContain(TOKEN);
    expect(key).toBe(accountKey('muse', `id:${EMAIL}`));
  });

  it('reads snake_case, and a flat usedPercent only when window is absent', () => {
    const snake = parseMuseUsage({
      schemaVersion: 1,
      allowance: {
        window: { used_percent: 35, window_duration_mins: 300, resets_at_ms: RESET_MS },
        weekly: { used_percent: 12, resets_at: WEEK_MS / 1000 },
      },
    });
    expect(snake.state).toBe('live');
    if (snake.state !== 'live') return;
    expect(snake.windows[0]?.used).toBe(35);
    expect(snake.windows[0]?.label).toBe('5-hour window');
    expect(snake.windows[1]?.resetsAt).toBe(WEEK_MS);

    const flat = parseMuseUsage({
      schemaVersion: 1,
      allowance: { usedPercent: 35, windowDurationMins: 300, resetsAtMs: RESET_MS },
    });
    expect(flat.state).toBe('live');
    if (flat.state !== 'live') return;
    expect(flat.windows).toHaveLength(1);
    expect(flat.windows[0]?.used).toBe(35);

    const preferred = parseMuseUsage({
      schemaVersion: 1,
      allowance: {
        usedPercent: 99,
        windowDurationMins: 60,
        resetsAtMs: RESET_MS,
        window: { usedPercent: 35, windowDurationMins: 300, resetsAtMs: RESET_MS },
      },
    });
    expect(preferred.state).toBe('live');
    if (preferred.state !== 'live') return;
    expect(preferred.windows).toHaveLength(1);
    expect(preferred.windows[0]?.used).toBe(35);
    expect(preferred.windows[0]?.label).toBe('5-hour window');
  });

  it('keeps used percent over 100, and leaves left at 0', () => {
    const read = parseMuseUsage(windowBody(135));
    expect(read.state).toBe('live');
    if (read.state !== 'live') return;
    expect(read.windows[0]?.used).toBe(135);
    const snapshot = allowanceSnapshot(
      {
        readAt: 50,
        timeZone: 'UTC',
        chosen: ['muse'],
        providers: [asMuse(read)],
      },
      [{ provider: 'muse', accountKey: '0123456789abcdef' }],
    );
    expect(snapshot?.accounts[0]?.windows[0]?.left).toBe(0);
  });

  it('does not invent a percent when allowance is null', () => {
    const hint = 'server sent nothing for ada@example.com';
    expect(
      parseMuseUsage({ schemaVersion: 1, allowance: null, reason: 'server_sent_no_usage', hint }),
    ).toEqual({ state: 'missing', reason: 'Muse sent no usage for this window yet.' });
    expect(parseMuseUsage({ schemaVersion: 1, allowance: null, reason: 'no_allowance' })).toEqual({
      state: 'missing',
      reason: 'Muse has no subscription allowance on this login.',
    });
    expect(parseMuseUsage({ schemaVersion: 1, allowance: null, reason: 'api_key' })).toEqual({
      state: 'missing',
      reason: 'This Muse login is an API key, which has no subscription window.',
    });
    expect(
      parseMuseUsage({ schemaVersion: 1, allowance: null, reason: 'something_else', hint }),
    ).toEqual({ state: 'missing', reason: 'Muse sent no usage for this window yet.' });
    const signedOut = parseMuseUsage({
      schemaVersion: 1,
      allowance: null,
      reason: 'server_sent_no_usage',
      hint: 'not logged in: run muse login first ada@example.com',
    });
    expect(signedOut).toEqual({
      state: 'missing',
      reason: 'Sign in to Muse on this machine, then refresh.',
    });
    expect(JSON.stringify(signedOut)).not.toContain(EMAIL);
    expect(JSON.stringify(signedOut)).not.toContain('%');
  });

  it('refuses an unknown schema, a missing reset, and a body that is not JSON', () => {
    expect(parseMuseUsage({ schemaVersion: 2, allowance: windowBody(35).allowance })).toEqual({
      state: 'error',
      reason: 'Muse sent something we could not read.',
    });
    expect(
      parseMuseUsage({
        schemaVersion: 1,
        allowance: { window: { usedPercent: 35, windowDurationMins: 300 } },
      }),
    ).toEqual({ state: 'error', reason: 'Muse left out the windows.' });
    expect(parseMuseText('not json')).toEqual({
      state: 'error',
      reason: 'Muse sent something we could not read.',
    });
    expect(parseMuseText('not logged in: run `muse login` first')).toEqual({
      state: 'missing',
      reason: 'Sign in to Muse on this machine, then refresh.',
    });
  });
});

describe('interpretMuseRun', () => {
  it('names a missing binary, a timeout, and still parses JSON from a failed exit', () => {
    expect(interpretMuseRun({ stdout: '', stderr: '', errorCode: 'ENOENT' })).toEqual({
      state: 'missing',
      reason: 'Muse is not installed on this machine.',
    });
    expect(
      interpretMuseRun({
        stdout: JSON.stringify(windowBody(35)),
        stderr: '',
        errorCode: 'TIMEOUT',
      }),
    ).toEqual({ state: 'error', reason: 'Muse did not answer.' });
    expect(interpretMuseRun({ stdout: '', stderr: 'boom', errorCode: 'TIMEOUT' }).state).toBe(
      'error',
    );
    const parsed = interpretMuseRun({ stdout: JSON.stringify(windowBody(35)), stderr: 'nope' });
    expect(parsed.state).toBe('live');
    expect(interpretMuseRun({ stdout: '', stderr: 'not logged in' })).toEqual({
      state: 'missing',
      reason: 'Sign in to Muse on this machine, then refresh.',
    });
  });
});

describe('readBoard muse', () => {
  it('uses the injected reader and does not require the CLI', async () => {
    const board = await readBoard({
      env: {},
      now: 1,
      timeZone: 'UTC',
      fetchSub: fetch,
      signal: AbortSignal.timeout(1_000),
      chosen: ['muse'],
      codexAuth: null,
      claudeToken: null,
      claudePlan: null,
      cursorToken: null,
      readMuse: async () =>
        parseMuseUsage({ schemaVersion: 1, allowance: null, reason: 'api_key' }),
    });
    expect(board.providers).toEqual([
      {
        id: 'muse',
        name: 'Muse',
        state: 'missing',
        reason: 'This Muse login is an API key, which has no subscription window.',
      },
    ]);
  });
});
