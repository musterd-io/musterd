import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveConfig } from './client';
import { QuickActionBar, StartAllResults, startAllSummary } from './quickActions';

describe('Start everyone results (seats ask 2c)', () => {
  it('says each count that is not zero, and never a wake cap (ADR 790)', () => {
    expect(
      startAllSummary([
        { seat: 'a', result: 'started' },
        { seat: 'b', result: 'started' },
        { seat: 'd', result: 'offline' },
      ]),
    ).toBe('Started 2 · 1 offline');
    expect(startAllSummary([])).toBe('No seats to start');
  });
});

describe('QuickActionBar (seats ask 2c)', () => {
  it('offers the four actions for the seat, in order', () => {
    const html = renderToStaticMarkup(
      createElement(QuickActionBar, { cfg: {} as LiveConfig, seat: 'ryder' }),
    );
    expect(html).toContain('aria-label="Quick actions for ryder"');
    const labels = [...html.matchAll(/class="qa__btn"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Start', 'Check inbox', 'Check PR', 'Resume']);
  });
  it('offers Stop only while the seat is on shift (ADR 792)', () => {
    const on = renderToStaticMarkup(
      createElement(QuickActionBar, { cfg: {} as LiveConfig, seat: 'ryder', onShift: true }),
    );
    const labels = [...on.matchAll(/class="qa__btn"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Start', 'Check inbox', 'Check PR', 'Resume', 'Stop']);
  });
  it("says each seat's result in words, and no string says capped", () => {
    const html = renderToStaticMarkup(
      createElement(StartAllResults, {
        seats: [
          { seat: 'ryder', result: 'started' },
          { seat: 'sloane', result: 'offline' },
        ],
      }),
    );
    expect(html).toContain('ryder</span> started');
    expect(html).toContain('sloane</span> offline');
    expect(html).not.toMatch(/cap/i);
  });
});
