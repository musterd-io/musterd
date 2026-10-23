import { describe, expect, it } from 'vitest';
import { openaiAccountKey } from './accountKey.js';
import { allowanceSnapshot } from './snapshot.js';
import type { Board } from './types.js';

const RAW_ID = 'acct_raw_chatgpt_id';
const TOKEN = 'sk-live-token-do-not-copy';

describe('allowanceSnapshot', () => {
  it('posts the plan and the windows, and not the account id or a token', () => {
    const board: Board = {
      readAt: 1_700_000_000_000,
      timeZone: 'UTC',
      chosen: ['openai', 'claude', 'opencode'],
      providers: [
        {
          id: 'openai',
          name: 'OpenAI',
          state: 'live',
          detail: 'pro',
          windows: [
            {
              id: 'primary',
              unit: 'percent',
              used: 62,
              limit: 100,
              resetsAt: 1_700_000_100_000,
              label: '5-hour window',
            },
            {
              id: 'secondary',
              unit: 'percent',
              used: 82,
              limit: 100,
              resetsAt: 1_700_000_200_000,
              label: 'weekly window',
            },
          ],
        },
        {
          id: 'opencode',
          name: 'OpenCode',
          state: 'quiet',
          reason: 'no window',
        },
        {
          id: 'claude',
          name: 'Claude',
          state: 'missing',
          reason: 'no sign-in',
        },
      ],
    };
    const key = openaiAccountKey(RAW_ID);
    const snapshot = allowanceSnapshot(board, [{ provider: 'openai', accountKey: key }]);
    const json = JSON.stringify(snapshot);
    expect(json).not.toContain(RAW_ID);
    expect(json).not.toContain(TOKEN);
    expect(json).not.toContain('opencode');
    expect(snapshot).toEqual({
      accounts: [
        {
          provider: 'openai',
          account: key,
          label: 'OpenAI pro',
          readAt: board.readAt,
          windows: [
            { name: '5h', left: 0.38, resetsAt: 1_700_000_100_000, kind: 'percent' },
            { name: 'week', left: 0.18, resetsAt: 1_700_000_200_000, kind: 'percent' },
          ],
        },
      ],
    });
  });

  it('keeps character counts on an amount window', () => {
    const board: Board = {
      readAt: 50,
      timeZone: 'UTC',
      chosen: ['elevenlabs'],
      providers: [
        {
          id: 'elevenlabs',
          name: 'ElevenLabs',
          state: 'live',
          detail: 'starter',
          windows: [
            { id: 'characters', unit: 'characters', used: 1000, limit: 10000, resetsAt: null },
          ],
        },
      ],
    };
    const snapshot = allowanceSnapshot(board, [
      { provider: 'elevenlabs', accountKey: '0123456789abcdef' },
    ]);
    expect(snapshot?.accounts[0]?.label).toBe('ElevenLabs starter');
    expect(snapshot?.accounts[0]?.windows[0]).toEqual({
      name: 'characters',
      left: 0.9,
      resetsAt: null,
      kind: 'amount',
      used: 1000,
      limit: 10000,
      unit: 'characters',
    });
  });
});
