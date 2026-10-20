import { describe, expect, it } from 'vitest';
import { QUIET } from './catalog.js';
import { renderPage } from './page.js';
import type { Board } from './types.js';

const board: Board = {
  readAt: Date.UTC(2026, 9, 19, 14, 14),
  timeZone: 'UTC',
  chosen: ['elevenlabs', 'openai', 'opencode'],
  providers: [
    {
      id: 'elevenlabs',
      name: 'ElevenLabs',
      state: 'live',
      detail: 'starter<script>',
      windows: [
        {
          id: 'characters',
          unit: 'characters',
          used: 1000,
          limit: 10000,
          resetsAt: Date.UTC(2026, 9, 20, 15, 0),
        },
      ],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      state: 'live',
      detail: null,
      windows: [
        {
          id: 'primary',
          unit: 'percent',
          used: 12,
          limit: 100,
          resetsAt: null,
          label: '5-hour window',
        },
      ],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      state: 'quiet',
      reason: 'OpenCode spends other providers. It has no window of its own.',
    },
  ],
};

describe('renderPage', () => {
  const html = renderPage(board);

  it('says what is left, and escapes a plan word', () => {
    expect(html).toContain('9,000 characters left of 10,000.');
    expect(html).toContain('88% left of the 5-hour window.');
    expect(html).toContain('starter&lt;script&gt;');
    expect(html).not.toContain('starter<script>');
    expect(html).toContain('class="meter-fill p10"');
    expect(html).toContain('Read at 2:14 PM.');
  });

  it('lists a quiet account with its reason and no number', () => {
    expect(html).toContain('<ul class="quiet">');
    expect(html).toContain('OpenCode spends other providers. It has no window of its own.');
    expect(html).not.toContain('aria-valuenow="0"');
    expect(QUIET.every((provider) => provider.reason !== '')).toBe(true);
  });

  it('puts live accounts on the board and the time in the header', () => {
    expect(html).toContain('<div class="board">');
    expect(html).toContain('<header class="top">');
    expect(html).toContain('class="win"');
    expect(html).not.toContain('class="foot"');
  });

  it('offers every account, and checks the ones that are on', () => {
    expect(html).toContain('<form method="post" action="/accounts">');
    expect(html).toContain('value="elevenlabs" checked');
    expect(html).toContain('value="openai" checked');
    expect(html).toContain('value="hume"');
    expect(html).not.toContain('value="hume" checked');
    expect(html).toContain('>Save</button>');
  });

  it('says so when nothing is selected', () => {
    const empty = renderPage({ ...board, chosen: [], providers: [] });
    expect(empty).toContain('Nothing on this page yet.');
    expect(empty).not.toContain('<article');
  });
});
