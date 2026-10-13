import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AskView } from './asks';
import { briefing } from './briefing';
import { goalStates, NowCard, othersLine, sinceLabel, stoppedLine } from './NowPanel';

const NOW = new Date('2026-10-08T09:00:00').getTime(); // a Thursday morning
const SINCE = new Date('2026-10-07T00:00:00').getTime();
const roster = [
  { name: 'ann', kind: 'agent', presence: 'online' },
  { name: 'bob', kind: 'agent', presence: 'online' },
  { name: 'nick', kind: 'human', presence: 'online' },
] as unknown as MemberSummary[];

const lane = (id: string, state: string, over: Record<string, unknown> = {}) => ({
  id,
  title: `title ${id}`,
  state,
  owner_seat: 'ann',
  goal_id: null,
  depends_on: [],
  claimed_at: NOW - 3_600_000,
  updated_at: NOW - 3_600_000,
  resolved_at: null,
  ...over,
});
const ask = (id: string, species: string, to: string | null): AskView =>
  ({
    env: { id, from: 'bob', ts: NOW - 7_200_000, body: `question ${id}` },
    species,
    tier: 'standard',
    to,
    deadline: NOW + 1,
    state: 'open',
  }) as unknown as AskView;

const make = (lanes: unknown[], asks: AskView[] = [], extra: Record<string, unknown> = {}) =>
  briefing({
    board: { lanes, warnings: [] } as unknown as LaneBoard,
    goals: [{ id: 'g1', title: 'Launch — ships publicly' }],
    asks,
    roster,
    now: NOW,
    shippedSince: SINCE,
    ...extra,
  });
const render = (
  lanes: unknown[],
  asks: AskView[] = [],
  opts: { full?: boolean; viewer?: string | null } = {},
) =>
  renderToStaticMarkup(
    createElement(NowCard, {
      brief: make(lanes, asks),
      roster,
      viewer: opts.viewer === undefined ? 'nick' : opts.viewer,
      now: NOW,
      since: SINCE,
      full: opts.full ?? false,
      onOpenAsk: () => {},
      onOpenLane: () => {},
      onOpenGoal: () => {},
      onLight: () => {},
    }),
  );

describe('NowCard', () => {
  it('heads the card with what waits on the viewer, and an Answer that opens it', () => {
    const html = render([], [ask('A1', 'approve', 'nick'), ask('A2', 'consult', 'nick')]);
    expect(html).toContain('Waiting on you · 2');
    expect(html).toContain('question A');
    expect(html).toContain('>Answer<');
  });

  it('gives an observer no band — what waits on nick is one quiet line', () => {
    const html = render([], [ask('A1', 'approve', 'nick')], { viewer: null });
    expect(html).not.toContain('Waiting on you');
    expect(html).toContain('1 waiting on nick');
  });

  it('draws a goal row as name, faces, a bar and "d of n done", with blocked in its own ink', () => {
    const html = render([
      lane('a', 'active', { goal_id: 'g1' }),
      lane('b', 'done', { goal_id: 'g1' }),
      lane('c', 'blocked', { goal_id: 'g1', owner_seat: 'bob' }),
    ]);
    expect(html).toContain('>Launch<');
    expect(html).toContain('1 of 3 done');
    expect(html).toContain('1 working');
    expect(html).toContain('<span class="nowc-blocked">1 blocked</span>');
    expect(html).toContain('aria-label="ann"');
    expect(html).toContain('aria-label="bob"');
    expect(html).toContain('width:33%');
  });

  it('shows four goals and says how many more', () => {
    const lanes = Array.from({ length: 6 }, (_, i) =>
      lane(`l${i}`, 'active', { goal_id: `g${i}`, claimed_at: NOW - i * 1000 }),
    );
    const html = render(lanes);
    expect(html.match(/class="nowc-goal"/g)).toHaveLength(4);
    expect(html).toContain('2 more goals');
    expect(render(lanes, [], { full: true }).match(/class="nowc-goal"/g)).toHaveLength(6);
  });

  it('lists who shipped since yesterday, most first, with their newest title', () => {
    const html = render([
      lane('s1', 'done', { owner_seat: 'bob', resolved_at: NOW - 60_000, title: 'newest thing' }),
      lane('s2', 'done', { owner_seat: 'bob', resolved_at: NOW - 120_000 }),
      lane('s3', 'done', { owner_seat: 'ann', resolved_at: NOW - 60_000 }),
    ]);
    expect(html).toContain('Shipped since yesterday');
    expect(html.indexOf('nowc-shiprow__who">bob')).toBeLessThan(html.indexOf('nowc-shiprow__who">ann'));
    expect(html).toContain('newest thing');
  });

  it('carries no colour that is not a face, mustard or blocked ink — no legend, no headline', () => {
    const html = render([lane('a', 'active', { goal_id: 'g1' })], [ask('A1', 'approve', 'nick')]);
    expect(html).not.toContain('in progress ·'); // the headline sentence is gone from the card
    expect(html).not.toMatch(/legend/i);
  });
});

describe('the words', () => {
  it('says states and others plainly', () => {
    expect(goalStates({ working: 4, review: 1 })).toBe('4 working · 1 in review');
    expect(goalStates({ working: 0, review: 0 })).toBe('');
    expect(
      othersLine([
        { who: 'sloane', n: 2 },
        { who: 'an admin', n: 1 },
      ]),
    ).toBe('2 waiting on sloane · 1 seat request');
  });

  it('says where the shipped list starts the way a person would', () => {
    expect(sinceLabel(SINCE, NOW)).toBe('yesterday');
    expect(sinceLabel(new Date('2026-10-02T00:00:00').getTime(), new Date('2026-10-05T09:00:00').getTime())).toBe(
      'Friday',
    );
  });
});

describe('Stopped', () => {
  // Lane 01M4V754ZD (nick, 2026-10-13): a plan whose later increments nobody is building shows on
  // the card, in its own section, instead of vanishing because nothing in it is "in motion".
  const DAY = 86_400_000;
  const goals = [
    { id: 'g1', title: 'Launch — ships publicly' },
    { id: 'g2', title: 'Office liveliness — the floor is alive' },
  ];
  const renderWith = (lanes: unknown[], full = false) =>
    renderToStaticMarkup(
      createElement(NowCard, {
        brief: make(lanes, [], { goals }),
        roster,
        viewer: 'nick',
        now: NOW,
        since: SINCE,
        full,
        onOpenAsk: () => {},
        onOpenLane: () => {},
        onOpenGoal: () => {},
        onLight: () => {},
      }),
    );

  it('draws a stopped goal as a row in its own section, naming the oldest lane on hover', () => {
    const html = renderWith([
      lane('a', 'open', { goal_id: 'g2', owner_seat: null, updated_at: NOW - 9 * DAY }),
      lane('b', 'done', { goal_id: 'g2', updated_at: NOW - 10 * DAY }),
    ]);
    expect(html).toContain('>Stopped<');
    expect(html).toContain('class="nowc-goal nowc-goal--stopped"');
    expect(html).toContain('>Office liveliness<');
    expect(html).toContain('1 of 2 done');
    expect(html).toContain('<span class="nowc-stop">nothing moved in 9d · 1 waiting, nobody&#x27;s</span>');
    expect(html).toContain('title="title a"');
  });

  it('shows a goal in motion and stopped at once, in both sections', () => {
    const html = renderWith([
      lane('a', 'active', { goal_id: 'g1' }),
      lane('b', 'open', { goal_id: 'g1', owner_seat: null, updated_at: NOW - 20 * DAY }),
    ]);
    expect(html).toContain('Goals in motion');
    expect(html).toContain('>Stopped<');
    expect(html.match(/>Launch</g)).toHaveLength(2);
    expect(html).toContain('<span class="nowc-stop">1 waiting, nobody&#x27;s · oldest 20d</span>');
  });

  it('has no Stopped section when nothing is stalled', () => {
    expect(renderWith([lane('a', 'active', { goal_id: 'g1' })])).not.toContain('>Stopped<');
  });

  it('shows three and says how many more', () => {
    const lanes = Array.from({ length: 5 }, (_, i) =>
      lane(`l${i}`, 'open', { goal_id: `g${i}`, owner_seat: null, updated_at: NOW - (8 + i) * DAY }),
    );
    const html = renderWith(lanes);
    expect(html.match(/nowc-goal--stopped"/g)).toHaveLength(3);
    expect(html).toContain('2 more stopped');
    expect(renderWith(lanes, true).match(/nowc-goal--stopped"/g)).toHaveLength(5);
  });

  it('says the line plainly for each shape', () => {
    const base = { key: 'k', goalId: 'g', name: 'G', title: 'G', done: 0, total: 1, oldest: null };
    expect(stoppedLine({ ...base, quiet: true, idleMs: 8 * DAY, orphans: 0 })).toBe(
      'nothing moved in 8d',
    );
    expect(stoppedLine({ ...base, quiet: true, idleMs: 8 * DAY, orphans: 2 })).toBe(
      "nothing moved in 8d · 2 waiting, nobody's",
    );
    expect(
      stoppedLine({ ...base, quiet: false, idleMs: 0, orphans: 1, oldest: { title: 't', idleMs: 20 * DAY } }),
    ).toBe("1 waiting, nobody's · oldest 20d");
  });
});
