import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveConfig } from './client';
import { QuickActionBar, StartAllResults, startAllSummary } from './quickActions';

describe('Start everyone results (seats ask 2c)', () => {
  it('says each count that is not zero, and names the wake cap', () => {
    expect(
      startAllSummary([
        { seat: 'a', result: 'started' },
        { seat: 'b', result: 'started' },
        { seat: 'c', result: 'capped' },
        { seat: 'd', result: 'offline' },
      ]),
    ).toBe('Started 2 · 1 held by its wake cap · 1 offline');
    expect(startAllSummary([])).toBe('No seats to start');
  });
});

describe('QuickActionBar (seats ask 2c)', () => {
  it('offers the four actions for the seat, in order', () => {
    const html = renderToStaticMarkup(createElement(QuickActionBar, { cfg: {} as LiveConfig, seat: 'ryder' }));
    expect(html).toContain('aria-label="Quick actions for ryder"');
    const labels = [...html.matchAll(/class="qa__btn"[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Start', 'Check inbox', 'Check PR', 'Resume']);
  });
  it('says a capped seat was held by its wake cap, seat by seat', () => {
    const html = renderToStaticMarkup(createElement(StartAllResults, { seats: [{ seat: 'ryder', result: 'capped' }] }));
    expect(html).toContain('held by wake cap');
  });
});
