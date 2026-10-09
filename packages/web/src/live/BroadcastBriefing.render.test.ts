import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Briefing, NeedsItem, ShippedItem, WorkItem } from './briefing';
import { BriefingView, BROADCAST_ROWS, pickBucket, publicNeeds } from './BroadcastBriefing';

const empty: Briefing = {
  needsHuman: [],
  inProgress: [],
  inReview: [],
  shipped: [],
  headline: 'quiet — nothing in flight',
};
const need = (id: string, over: Partial<NeedsItem> = {}): NeedsItem => ({
  id,
  kind: 'blocked',
  title: `blocked ${id}`,
  owner: 'ann',
  waitingOn: null,
  since: 0,
  laneId: id,
  ref: id,
  ...over,
});
const review = (n: number): WorkItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `lane:r${i}`,
    title: `review ${i}`,
    owner: 'bob',
    goal: null,
    since: 0,
  }));
const shipped = (n: number): ShippedItem[] =>
  Array.from({ length: n }, (_, i) => ({ id: `lane:s${i}`, title: `shipped ${i}`, by: 'cy', at: 0 }));
const render = (brief: Briefing, tick = 0) =>
  renderToStaticMarkup(createElement(BriefingView, { brief, tick }));

describe('pickBucket', () => {
  it('holds on Needs a human for every tick while anything is in it', () => {
    const brief = { ...empty, needsHuman: [need('a')], inReview: review(2), shipped: shipped(2) };
    for (const tick of [0, 1, 2, 3, 99]) expect(pickBucket(brief, tick)).toBe('needs');
  });

  it('otherwise takes turns between the non-empty buckets', () => {
    const brief = { ...empty, inReview: review(1), shipped: shipped(1) };
    expect([0, 1, 2, 3].map((t) => pickBucket(brief, t))).toEqual([
      'inReview',
      'shipped',
      'inReview',
      'shipped',
    ]);
  });

  it('skips an empty bucket and shows nothing for an empty brief', () => {
    expect(pickBucket({ ...empty, shipped: shipped(1) }, 0)).toBe('shipped');
    expect(pickBucket({ ...empty, shipped: shipped(1) }, 1)).toBe('shipped');
    expect(pickBucket(empty, 0)).toBeNull();
  });

  it('does not let a seat request hold the frame', () => {
    const brief = {
      ...empty,
      needsHuman: [need('r', { kind: 'seat-request', laneId: null, title: 'wants to join as zed' })],
      shipped: shipped(1),
    };
    expect(pickBucket(brief, 0)).toBe('shipped');
  });
});

describe('BriefingView — a public surface', () => {
  it('never names a seat request, even if one reaches it', () => {
    const html = render({
      ...empty,
      headline: '1 needs a human',
      needsHuman: [
        need('r', { kind: 'seat-request', laneId: null, title: 'wants to join as zed', owner: null }),
        need('b'),
      ],
    });
    expect(publicNeeds({ ...empty, needsHuman: [need('r', { kind: 'seat-request' })] })).toEqual([]);
    expect(html).not.toContain('wants to join');
    expect(html).not.toContain('zed');
    expect(html).toContain('blocked b');
  });

  it('shows the headline and a blocked lane with its owner', () => {
    const html = render({ ...empty, headline: '3 in progress · 1 needs a human', needsHuman: [need('a')] });
    expect(html).toContain('3 in progress · 1 needs a human');
    expect(html).toContain('Needs a human');
    expect(html).toContain('blocked a');
    expect(html).toContain('ann');
  });

  it('caps the rows and says how many more', () => {
    const html = render({ ...empty, shipped: shipped(7) });
    expect((html.match(/class="bb__row"/g) ?? []).length).toBe(BROADCAST_ROWS);
    expect(html).toContain(`+${7 - BROADCAST_ROWS} more`);
  });

  it('is just the sentence when nothing is in flight', () => {
    const html = render(empty);
    expect(html).toContain('quiet — nothing in flight');
    expect(html).not.toContain('bb__bucket');
  });

  it('survives an item with no owner', () => {
    const html = render({ ...empty, needsHuman: [need('a', { owner: null })] });
    expect(html).toContain('blocked a');
    expect(html).not.toContain('undefined');
    expect(html).not.toContain('null');
  });
});
