import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TopMeter } from './TopMeter';

const roster = [
  { name: 'ann', kind: 'agent', presence: 'online', posture: 'working' },
  { name: 'bob', kind: 'agent', presence: 'online', posture: 'between' },
] as unknown as MemberSummary[];
const render = (headline?: string) =>
  renderToStaticMarkup(
    createElement(TopMeter, {
      teamName: 'revive',
      envelopes: [],
      roster,
      now: 0,
      ...(headline === undefined ? {} : { headline }),
    }),
  );

describe('TopMeter', () => {
  it('speaks the briefing headline in place of the posture tally', () => {
    const html = render('2 in progress · 1 needs a human');
    expect(html).toContain('2 in progress · 1 needs a human');
    expect(html).not.toContain('between tasks');
  });

  it('keeps the posture tally when no headline is given', () => {
    expect(render()).toContain('1 working');
  });
});
