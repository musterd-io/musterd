import type { LaneBoard, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamColumn } from './TeamColumn';

const m = (name: string, over: Record<string, unknown> = {}) =>
  ({
    id: `m_${name}`,
    name,
    kind: 'agent',
    presence: 'online',
    posture: 'working',
    capabilities: {},
    presences: [
      {
        status: 'online',
        surface: 'claude-code',
        model: 'claude-opus-5-5',
        model_source: 'observed',
      },
    ],
    ...over,
  }) as unknown as MemberSummary;
const board = {
  lanes: [
    {
      id: 'lane_01M3ZZZZ',
      title: 'Trace coverage for every harness',
      owner_seat: 'ryder',
      state: 'claimed',
      claimed_at: 0,
      updated_at: 0,
      goal_id: 'launch',
      areas: ['ui'],
    },
  ],
} as unknown as LaneBoard;
const render = (props: Record<string, unknown>) =>
  renderToStaticMarkup(
    createElement(TeamColumn, {
      roster: [],
      board: null,
      goals: [],
      now: 42 * 60_000,
      ...props,
    } as never),
  );

describe('TeamColumn', () => {
  it('a card says who, which model, and what — in words a room can read', () => {
    const html = render({
      roster: [m('ryder')],
      board,
      goals: [{ id: 'launch', title: 'Launch' }],
    });
    expect(html).toContain('ryder');
    expect(html).toContain('Opus 5.5');
    expect(html).toContain('working on');
    expect(html).toContain('Trace coverage for every harness');
    expect(html).toContain('for Launch · ui · 42m');
    expect(html).toContain('<svg'); // the provider logo, not just a tint
  });

  it('a declared model says so', () => {
    const html = render({
      roster: [
        m('a', { presences: [{ status: 'online', model: 'gpt-6-luna', model_source: 'binding' }] }),
      ],
    });
    expect(html).toContain('GPT 6');
    expect(html).toMatch(/declared/);
  });

  it('offline seats fold into one line', () => {
    const html = render({ roster: [m('a'), m('b', { presence: 'offline', posture: 'offline' })] });
    expect(html).toContain('+ 1 offline');
    expect(html).not.toContain('>b<');
  });

  it('collapsed: a rail of avatars, each carrying its provider logo and a labelled state', () => {
    const html = render({ roster: [m('ryder')], board, collapsed: true, onCollapse: () => {} });
    expect(html).toContain('lc-team__rail');
    expect(html).toMatch(/aria-label="ryder — Opus 5.5 — working on/);
  });

  it('the linked member is marked, so the office and the card read as one person', () => {
    const html = render({ roster: [m('ryder')], linked: 'ryder' });
    expect(html).toMatch(/lc-team-card[^"]*is-linked/);
  });

  it('never prints a lane id', () => {
    expect(render({ roster: [m('ryder')], board })).not.toContain('01M3ZZZZ');
  });

  it('a member with an open ask to a human reads "asking nick" (ADR 464 §4)', () => {
    const askView = {
      env: {
        id: 'ask1',
        from: 'ryder',
        to: { kind: 'member', name: 'nick' },
        ts: 1,
        act: 'ask',
        body: '',
      },
      species: 'approve',
      tier: 'standard',
      to: 'nick',
      deadline: 2,
      state: 'open',
    } as unknown as import('./asks').AskView;
    const html = render({
      roster: [m('ryder'), m('nick', { kind: 'human', posture: 'active' })],
      board,
      asks: [askView],
    });
    expect(html).toContain('asking nick');
    expect(html).toContain('lc-team-card--asking');
  });

  it('the viewer\'s own card says "you", and nobody else\'s does (lane 01M50CD7SN)', () => {
    const html = render({ roster: [m('ryder'), m('nick', { kind: 'human' })], board, you: 'nick' });
    expect(html.match(/lc-team-card__you/g)?.length).toBe(1);
    expect(render({ roster: [m('nick', { kind: 'human' })], board })).not.toContain('lc-team-card__you');
  });

  it('still (the stream): the same card, nothing to press, no operator notes (ADR 464 lane 5)', () => {
    const html = render({
      roster: [m('ryder')],
      board,
      goals: [{ id: 'launch', title: 'Launch' }],
      unreadable: 2,
      still: true,
    });
    expect(html).toContain('Trace coverage for every harness');
    expect(html).toContain('is-still');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('newer than this page');
  });

  it('still: seats between tasks are names in one strip, not cards quoting their status', () => {
    const html = render({
      roster: [m('ryder'), m('ghost', { state: 'dreaming about lanes' }), m('izzo')],
      board,
      goals: [{ id: 'launch', title: 'Launch' }],
      still: true,
    });
    expect(html.match(/lc-team-card /g)).toHaveLength(1); // ryder, working
    expect(html).toContain('lc-team__idle');
    expect(html).toMatch(/between tasks <span class="lc-team__idle-count">2<\/span>/);
    expect(html).toContain('ghost');
    expect(html).not.toContain('dreaming about lanes');
  });

  it('/live (not still) keeps a card for every present seat', () => {
    const html = render({ roster: [m('ryder'), m('ghost')], board });
    expect(html.match(/lc-team-card /g)).toHaveLength(2);
    expect(html).not.toContain('lc-team__idle');
  });

  it('says when this page cannot read every seat', () => {
    expect(render({ roster: [m('a')], unreadable: 1 })).toContain('reload to meet');
  });
});
