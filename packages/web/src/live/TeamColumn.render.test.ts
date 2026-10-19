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

  describe('Experiments (ADR 644)', () => {
    // Sat 2026-10-17, 15:00 in Los Angeles.
    const NOW = Date.UTC(2026, 9, 17, 22, 0);
    const read = (id: string, status: string, readsOn: string, over: object = {}) => ({
      id,
      title: `Read ${id}`,
      owner_seat: 'stanley',
      state: 'claimed',
      reads_on: readsOn,
      read_status: status,
      ...over,
    });
    const dated = (...lanes: object[]) => ({ lanes, warnings: [] }) as unknown as LaneBoard;
    const four = dated(
      read('w', 'waiting', '2026-11-02'),
      read('r', 'read', '2026-10-16', {
        read_verdict: { outcome: 'missed', note: 'lost to baseline', by: 'stanley', at: NOW },
      }),
      read('d', 'due', '2026-10-17'),
      read('o', 'overdue', '2026-10-15'),
    );

    it('lists overdue, due, waiting, read — in words, with the urgent count in the head', () => {
      const html = render({ roster: [m('ryder')], board: four, now: NOW });
      expect(html).toContain('Experiments');
      expect(html).toContain('1 overdue · 1 due');
      const order = ['overdue · 2 days', 'due today', 'in 16 days', 'missed'].map((p) =>
        html.indexOf(p),
      );
      expect(order.every((i) => i > 0)).toBe(true);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      // The date rides a calendar leaf: the month on its band, the day under it, the weekday in its tooltip.
      expect(html).toMatch(/title="MON 2 Nov"><span class="lc-xp__tack"><\/span><span class="lc-xp__leaf-mo">Nov<.*lc-xp__leaf-day">2</);
      expect(html).toContain('“lost to baseline”');
      // A verdict is stamped on its leaf.
      expect(html).toContain('lc-xp__stamp lc-xp__stamp--missed');
    });

    it('wears the owner\'s avatar in their roster colour, and none for a seat not on the roster', () => {
      const withOwner = render({ roster: [m('stanley')], board: four, now: NOW });
      expect(withOwner).toMatch(/lc-xp__avatar" style="background:hsl\([^"]+\)" aria-hidden="true">S</);
      expect(render({ roster: [m('ryder')], board: four, now: NOW })).not.toContain('lc-xp__avatar');
    });

    it('a metric lane draws a sparkline and its read shows the number beside the word (lane 01M5B1ZM80)', () => {
      const metric = { name: 'ranked pick hit rate', unit: '%', baseline: 40, target: 60, direction: 'up', source: 'manual', by: 'ryder', at: NOW };
      const board = dated(
        read('m', 'read', '2026-10-16', {
          read_verdict: { outcome: 'met', note: 'Ranked picks won. Baseline held.', by: 'ryder', at: NOW, measured: { value: 61, n: 23 }, evidence: 'https://example.test/readout' },
          metric,
          samples: [
            { day: '2026-10-14', value: 48, n: 2, by: 'ryder', at: NOW },
            { day: '2026-10-15', value: 55, n: 2, by: 'ryder', at: NOW },
            { day: '2026-10-16', value: 61, n: 3, by: 'ryder', at: NOW },
          ],
        }),
        read('p', 'waiting', '2026-10-30'),
      );
      const html = render({ roster: [m('ryder')], board, now: NOW });
      expect(html).toContain('met · 61% (target 60%, n 23)');
      expect(html).toContain('lc-xp__spark is-read');
      expect(html).toContain('lc-xp__spark-target');
      expect(html).toContain('lc-xp__spark-latest">61%');
      // Closed, the note is its first sentence; the evidence is a link because it is a URL.
      expect(html).toContain('“Ranked picks won.”');
      expect(html).toContain('href="https://example.test/readout"');
      // The plain read draws nothing.
      expect((html.match(/lc-xp__spark /g) ?? []).length).toBe(1);
    });

    it('lays the reads on a fortnight strip: overdue in the gutter, a far read at the edge', () => {
      const html = render({ roster: [m('ryder')], board: four, now: NOW });
      expect(html).toContain('lc-xp__pin lc-xp__pin--overdue" style="--d:-1');
      expect(html).toContain('lc-xp__pin lc-xp__pin--due" style="--d:0');
      expect(html).toContain('lc-xp__pin lc-xp__pin--waiting" style="--d:15');
    });

    it('/live rows link to the lane on the board', () => {
      const html = render({ roster: [m('ryder')], board: four, now: NOW });
      expect(html).toContain('href="/board?lane=o"');
      expect(html).toMatch(/aria-label="Read o, overdue · 2 days, reads Thursday, October 15, owner stanley"/);
    });

    it('caps at five but never hides an urgent row; /live toggles, the stream says how many more', () => {
      const many = dated(
        ...Array.from({ length: 6 }, (_, i) => read(`o${i}`, 'overdue', '2026-10-1' + i)),
        read('w1', 'waiting', '2026-10-30'),
        read('w2', 'waiting', '2026-10-31'),
      );
      const live = render({ roster: [m('ryder')], board: many, now: NOW });
      expect(live.match(/lc-xp__row /g)).toHaveLength(6);
      expect(live).toContain('Show all 8');
      const stream = render({ roster: [m('ryder')], board: many, now: NOW, still: true });
      expect(stream.match(/lc-xp__row /g)).toHaveLength(6);
      expect(stream).toContain('+2 more on the board');
      expect(stream).not.toContain('href="/board');
    });

    it('empty: one line on /live, nothing on the stream', () => {
      expect(render({ roster: [m('ryder')], board, now: NOW })).toContain(
        'No dated reads. Open a lane with --reads-on to add one.',
      );
      expect(render({ roster: [m('ryder')], board, now: NOW, still: true })).not.toContain(
        'Experiments',
      );
    });

    it('absent while the board loads', () => {
      expect(render({ roster: [m('ryder')], board: null, now: NOW })).not.toContain('Experiments');
      expect(render({ roster: [], board: four, now: NOW, loading: true })).not.toContain(
        'Experiments',
      );
    });

    it('never derives a status from the date: the server says waiting, the row says waiting', () => {
      const html = render({
        roster: [m('ryder')],
        board: dated(read('x', 'waiting', '2026-10-01')),
        now: NOW,
      });
      expect(html).toContain('lc-xp__row--waiting');
      expect(html).not.toContain('overdue');
    });

    it('collapsed: the overdue count rides under the rail', () => {
      const html = render({ roster: [m('ryder')], board: four, now: NOW, collapsed: true, onCollapse: () => {} });
      expect(html).toContain('aria-label="1 overdue read"');
    });
  });
});
