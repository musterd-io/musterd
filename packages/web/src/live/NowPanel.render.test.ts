import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AskView } from './asks';
import { briefing } from './briefing';
import { NowSections, ownersOf, sinceLabel } from './NowPanel';

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
const render = (lanes: unknown[], asks: AskView[] = [], full = false, extra = {}) =>
  renderToStaticMarkup(
    createElement(NowSections, {
      brief: make(lanes, asks, extra),
      roster,
      now: NOW,
      since: SINCE,
      full,
      onOpenLane: () => {},
      onOpenAsk: () => {},
      onMore: () => {},
    }),
  );

describe('NowSections — needs a human', () => {
  it('heads each human with what they are being asked for, by name', () => {
    const html = render([], [ask('1', 'approve', 'nick'), ask('2', 'consult', 'nick')]);
    expect(html).toContain('Needs approval and clarification from nick');
    expect(html).toContain('question 1');
    expect(html).toContain('now-sec--needs is-loud');
  });

  it('gives blocked lanes their own header and names no human for them', () => {
    const html = render([lane('c', 'blocked')]);
    expect(html).toContain('Blocked');
    expect(html).not.toContain('now-h--loud'); // no human heading: a lane names no one to ask
  });

  it('says what a blocked lane waits on', () => {
    const html = render([
      lane('dep', 'active', { title: 'the thing it needs', owner_seat: 'bob' }),
      lane('c', 'blocked', { depends_on: ['dep'] }),
    ]);
    expect(html).toContain('waits on the thing it needs (bob)');
  });

  it('is calm when nothing is waiting or blocked', () => {
    const html = render([lane('a', 'active')]);
    expect(html).toContain('Nothing is waiting on anyone, and nothing is blocked.');
    expect(html).not.toContain('is-loud');
  });

  it('sends a seat claim to an admin and to the approvals page', () => {
    const req = { id: 'r1', target: 'seat:zed', ts: NOW - 60_000, status: 'pending' };
    const html = render([], [], false, { requests: [req] });
    expect(html).toContain('Needs approval from an admin');
    expect(html).toContain('href="/approvals"');
  });
});

describe('NowSections — the plate, by goal, and what landed, by person', () => {
  it('groups in progress by goal, not by person', () => {
    const html = render([
      lane('a', 'active', { goal_id: 'g1' }),
      lane('b', 'active', { goal_id: 'g1', owner_seat: 'bob' }),
      lane('c', 'active'),
    ]);
    expect(html).toContain('by goal');
    expect(html).toContain('Launch');
    expect(html).toContain('No goal');
  });

  it('is a one-line-per-goal summary in the overlay, and every lane in full', () => {
    const lanes = Array.from({ length: 5 }, (_, i) => lane(`w${i}`, 'active', { goal_id: 'g1' }));
    const overlay = render(lanes);
    expect((overlay.match(/class="now-r"/g) ?? []).length).toBe(1); // the goal's one line
    expect(overlay).toContain('Launch');
    expect(overlay).not.toContain('title w0'); // lane titles wait for the full view
    const full = render(lanes, [], true);
    expect(full).toContain('is-full');
    expect(full).toContain('title w0');
    expect((full.match(/class="now-r"/g) ?? []).length).toBe(5);
  });

  it('lists what shipped by who shipped it, since yesterday', () => {
    const html = render([
      lane('s1', 'done', { owner_seat: 'ann', resolved_at: NOW - 1000 }),
      lane('s2', 'done', { owner_seat: 'bob', resolved_at: NOW - 2000 }),
    ]);
    expect(html).toContain('since yesterday');
    expect(html).toContain('ann');
    expect(html).toContain('bob');
  });

  it('survives an owner who is not on the roster, and an empty team', () => {
    const html = render([lane('a', 'active', { owner_seat: 'ghost' })]);
    expect(html).not.toContain('undefined');
    expect(render([])).toContain('no lanes in hand');
  });
});

describe('ownersOf', () => {
  it('names who is on a goal, three at most', () => {
    expect(ownersOf(['ann', 'bob', 'ann', null])).toBe('ann, bob');
    expect(ownersOf(['a', 'b', 'c', 'd', 'e'])).toBe('a, b, c +2');
    expect(ownersOf([])).toBe('');
  });
});

describe('sinceLabel', () => {
  it('says yesterday for yesterday and the weekday beyond it', () => {
    expect(sinceLabel(new Date('2026-10-07T00:00:00').getTime(), NOW)).toBe('yesterday');
    expect(sinceLabel(new Date('2026-10-02T00:00:00').getTime(), new Date('2026-10-05T09:00:00').getTime())).toBe('Friday');
  });
});
