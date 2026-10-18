import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { sparkPath, TopMeter } from './TopMeter';

const roster = [
  { name: 'ann', kind: 'agent', presence: 'online', posture: 'working' },
  { name: 'bob', kind: 'agent', presence: 'online', posture: 'between' },
] as unknown as MemberSummary[];
const render = () =>
  renderToStaticMarkup(createElement(TopMeter, { teamName: 'revive', envelopes: [], roster, now: 0 }));

describe('TopMeter', () => {
  // Live-briefing spec, increment 4: the counts live in the Now card. A tally here was the same
  // facts a second time, and the long headline ran under the topbar buttons (#2290).
  it('carries no tally and no headline — the Now card has the counts', () => {
    const html = render();
    expect(html).not.toContain('working');
    expect(html).not.toContain('between tasks');
    expect(html).not.toContain('lc-meter__who');
  });
});

describe('sparkPath', () => {
  it('runs through the middle of each bucket and closes to the baseline for the fill', () => {
    expect(sparkPath([0, 2, 1], 2, false)).toBe('M2 11.5 L6 1.5 L10 6.5');
    expect(sparkPath([0, 2, 1], 2, true)).toBe('M2 11.5 L6 1.5 L10 6.5 L10 12 L2 12 Z');
  });
  it('draws flat ground for one bucket and nothing for none', () => {
    expect(sparkPath([1], 1, false)).toBe('M0 1.5 L2 1.5');
    expect(sparkPath([], 1, false)).toBe('');
  });
});
