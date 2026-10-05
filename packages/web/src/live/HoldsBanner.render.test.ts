import type { Hold } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HoldsBanner } from './HoldsBanner';

/** ADR 516: the /live banner renders what is in force and nothing else (first frame, no DOM). */
describe('HoldsBanner', () => {
  const now = new Date(2026, 9, 5, 14, 0).getTime();
  const hold: Hold = {
    id: 'h1',
    effect: 'autorefresh_paused',
    reason: 'demo 14:00',
    created_by: 'nick',
    created_at: now,
    expires_at: now + 90 * 60_000,
    lifted_at: null,
    lifted_by: null,
  };
  const html = (holds: Hold[]) => renderToStaticMarkup(createElement(HoldsBanner, { holds, now }));

  it('names the effect, the human, the end and the reason', () => {
    expect(html([hold])).toContain('autorefresh paused by nick until 15:30 (1h30m left): demo 14:00');
  });

  it('a notice says it is not enforced', () => {
    expect(html([{ ...hold, effect: 'notice' }])).toContain('notice — not enforced');
  });

  it('renders nothing for no hold, a lifted one or an ended one', () => {
    expect(html([])).toBe('');
    expect(html([{ ...hold, lifted_at: now, lifted_by: 'nick' }])).toBe('');
    expect(html([{ ...hold, expires_at: now }])).toBe('');
  });
});
