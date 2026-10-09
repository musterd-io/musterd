import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TopMeter } from './TopMeter';

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
