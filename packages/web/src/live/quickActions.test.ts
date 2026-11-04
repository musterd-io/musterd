import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveConfig } from './client';
import { QuickActionBar, quickStateLabel, seatActions, StartAllResults, startAllSummary } from './quickActions';

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

describe('seatActions — the same buttons the phone offers (lane 01M6KZZ5WH)', () => {
  it('offers Start only to an offline seat that can be woken', () => {
    expect(seatActions({ online: false, wakeable: true, lane: false })).toEqual(['start', 'check_inbox', 'resume']);
    expect(seatActions({ online: false, wakeable: false, lane: false })).toEqual(['check_inbox', 'resume']);
    expect(seatActions({ online: true, wakeable: true, lane: false })).toEqual(['check_inbox', 'resume', 'stop']);
  });
  it('offers Check PR only with a lane, and Stop while online or on shift', () => {
    expect(seatActions({ online: true, wakeable: false, lane: true })).toEqual(['check_inbox', 'check_pr', 'resume', 'stop']);
    expect(seatActions({ online: false, wakeable: true, lane: true, onShift: true })).toEqual([
      'start',
      'check_inbox',
      'check_pr',
      'resume',
      'stop',
    ]);
  });
});

const labelsOf = (html: string) => [...html.matchAll(/class="qa__label">([^<]+)</g)].map((m) => m[1]);

describe('QuickActionBar (seats ask 2c)', () => {
  it('shows the actions it is given, in order, each its own button', () => {
    const html = renderToStaticMarkup(
      createElement(QuickActionBar, {
        cfg: {} as LiveConfig,
        seat: 'ryder',
        actions: seatActions({ online: false, wakeable: true, lane: true }),
      }),
    );
    expect(html).toContain('aria-label="Quick actions for ryder"');
    expect(labelsOf(html)).toEqual(['Start', 'Check inbox', 'Check PR', 'Resume']);
    expect(html).toContain('qa__btn qa__btn--start');
  });
  it('never offers Start to a seat that is already here', () => {
    const html = renderToStaticMarkup(
      createElement(QuickActionBar, {
        cfg: {} as LiveConfig,
        seat: 'ryder',
        actions: seatActions({ online: true, wakeable: true, lane: false }),
      }),
    );
    expect(labelsOf(html)).toEqual(['Check inbox', 'Resume', 'Stop']);
  });
});

describe('quick-send outcome words', () => {
  it('reads like the phone: Sending…, Sent, Couldn’t send', () => {
    expect(quickStateLabel('start', undefined)).toBe('Start');
    expect(quickStateLabel('start', 'sending')).toBe('Sending…');
    expect(quickStateLabel('start', 'sent')).toBe('Sent');
    expect(quickStateLabel('start', 'failed')).toBe('Couldn’t send');
  });
});

describe('Start everyone results, rendered', () => {
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
