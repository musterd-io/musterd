import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Briefing, NeedsItem, WorkItem } from './briefing';
import { LOUD_ROWS, NowSections, QUIET_ROWS } from './NowPanel';

const NOW = 1_800_000_000_000;
const empty: Briefing = { needsHuman: [], inProgress: [], inReview: [], shipped: [], headline: '' };
const roster = [{ name: 'ann', kind: 'agent', presence: 'online' }] as unknown as MemberSummary[];
const need = (id: string, over: Partial<NeedsItem> = {}): NeedsItem => ({
  id,
  kind: 'blocked',
  title: `title ${id}`,
  owner: 'ann',
  waitingOn: null,
  since: NOW - 3_600_000,
  laneId: id,
  ref: id,
  ...over,
});
const work = (n: number): WorkItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `lane:w${i}`,
    title: `work ${i}`,
    owner: 'ann',
    goal: null,
    since: NOW - 60_000,
  }));
const render = (brief: Briefing) =>
  renderToStaticMarkup(
    createElement(NowSections, {
      brief,
      roster,
      now: NOW,
      onOpenLane: () => {},
      onOpenAsk: () => {},
      onOpenBoard: () => {},
    }),
  );

describe('NowSections', () => {
  it('goes loud, with the full title, when something needs a human', () => {
    const long = 'a blocked lane whose title is long enough that clipping it would hide the point';
    const html = render({ ...empty, needsHuman: [need('a', { title: long })] });
    expect(html).toContain('now-needs is-loud');
    expect(html).toContain(long);
    expect(html).toContain('blocked');
    expect(html).toContain('1h');
  });

  it('says so calmly when nothing is waiting', () => {
    const html = render(empty);
    expect(html).toContain('nothing is waiting on anyone');
    expect(html).not.toContain('is-loud');
  });

  it('renders a seat request as a link to /approvals and an ask as a button', () => {
    const html = render({
      ...empty,
      needsHuman: [
        need('r1', { kind: 'seat-request', laneId: null, owner: null, title: 'wants to join as zed' }),
        need('e1', { kind: 'ask', laneId: null }),
      ],
    });
    expect(html).toContain('href="/approvals"');
    expect(html).toContain('wants to join as zed');
    expect(html).toContain('<button');
  });

  it('mounts a bounded number of rows and says how many more the board holds', () => {
    const html = render({ ...empty, inProgress: work(20) });
    const rows = html.match(/class="now-row"/g) ?? [];
    expect(rows).toHaveLength(QUIET_ROWS);
    expect(html).toContain(`+${20 - QUIET_ROWS} more on the board`);
  });

  it('hides less in the loud section', () => {
    const html = render({
      ...empty,
      needsHuman: Array.from({ length: LOUD_ROWS + 2 }, (_, i) => need(`n${i}`)),
    });
    expect((html.match(/class="now-need now-need--blocked"/g) ?? []).length).toBe(LOUD_ROWS);
    expect(html).toContain('+2 more on the board');
  });

  it('survives an owner who is not on the roster', () => {
    const html = render({ ...empty, inProgress: [{ ...work(1)[0]!, owner: 'ghost' }] });
    expect(html).toContain('ghost');
    expect(html).not.toContain('undefined');
  });
});
