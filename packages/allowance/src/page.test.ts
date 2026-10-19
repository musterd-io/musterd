import { describe, expect, it } from 'vitest';
import { QUIET } from './catalog.js';
import { renderPage } from './page.js';
import type { Board } from './types.js';

const board: Board = {
  readAt: Date.UTC(2026, 9, 19, 14, 14),
  timeZone: 'UTC',
  active: [
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
  ],
  quiet: [...QUIET],
};

describe('renderPage', () => {
  const html = renderPage(board);

  it('says what is left, and escapes a plan word', () => {
    expect(html).toContain('9,000 characters left of 10,000.');
    expect(html).toContain('starter&lt;script&gt;');
    expect(html).not.toContain('starter<script>');
    expect(html).toContain('class="meter-fill p10"');
    expect(html).toContain('Read at 2:14 PM.');
  });

  it('lists the quiet providers with reasons and no numbers', () => {
    for (const provider of QUIET) {
      expect(html).toContain(provider.name);
      expect(html).toContain(provider.reason);
    }
    expect(html).not.toContain('aria-valuenow="0"');
    expect(QUIET.every((provider) => !('windows' in provider))).toBe(true);
  });
});
