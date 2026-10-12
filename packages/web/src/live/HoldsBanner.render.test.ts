import type { Hold } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { HoldsBanner, HoldsPause } from './HoldsBanner';

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

  // ADR 516 increment 4: the controls render from the daemon's `can_set` alone.
  const cfg = { team: 'dawn', as: 'nick', token: 'mscr_x' };
  const withCfg = (holds: Hold[], canSet: boolean) =>
    renderToStaticMarkup(createElement(HoldsBanner, { holds, now, cfg, canSet }));

  it('a viewer the daemon says may set sees lift on each hold; pause… lives in the topbar', () => {
    const out = withCfg([hold], true);
    expect(out).toContain('>lift<');
    expect(out).not.toContain('pause…');
    // With nothing in force the banner is gone — it used to be an empty bar carrying pause… alone
    // (nick, 2026-10-12). The control renders from HoldsPause, on the same can_set rule.
    expect(withCfg([], true)).toBe('');
    const pause = renderToStaticMarkup(createElement(HoldsPause, { cfg }));
    expect(pause).toContain('pause…');
    expect(pause).not.toContain('>lift<');
  });

  it('a viewer who may not set sees the banner and no controls — even signed in', () => {
    const out = withCfg([hold], false);
    expect(out).toContain('autorefresh paused by nick');
    expect(out).not.toContain('>lift<');
    expect(out).not.toContain('pause…');
    expect(withCfg([], false)).toBe('');
  });
});
