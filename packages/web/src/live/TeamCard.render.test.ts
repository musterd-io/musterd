import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TeamCard } from './TeamCard';
import type { TeamCard as Card } from './teamCards';

/**
 * The card's own marks — rendered with `react-dom/server`, no DOM, as `RosterPanel.render.test.ts`
 * explains. The claim here: a seat a human reported (ADR 676 §8) says so on the card itself, not
 * only in the detail a click expands.
 */

const card = (member: Partial<MemberSummary> = {}): Card => ({
  name: 'ada',
  kind: 'agent',
  color: '#4b43b8',
  member: {
    id: 'm_ada',
    name: 'ada',
    kind: 'agent',
    presence: 'online',
    presences: [],
    ...member,
  } as unknown as MemberSummary,
  state: 'working',
  stateLabel: 'working on',
  title: null,
  source: null,
  goal: null,
  areas: [],
  since: null,
  moreLanes: 0,
});

const render = (c: Card, opts?: { still?: boolean; now?: number }) =>
  renderToStaticMarkup(
    createElement(TeamCard, {
      card: c,
      now: opts?.now ?? 0,
      linked: false,
      still: opts?.still ?? false,
    }),
  );

describe('TeamCard — a reported seat is flagged on the card (ADR 676 §8)', () => {
  it('shows the mark with its count in the tooltip', () => {
    const html = render(card({ reported_asks: { count: 2, last_at: 1 } }));
    expect(html).toContain('lc-seat__reported');
    expect(html).toContain('2 asks');
    expect(html).toContain('Nothing is blocked');
  });

  it('stays quiet with no report, or from an older daemon', () => {
    expect(render(card({ reported_asks: null }))).not.toContain('lc-seat__reported');
    expect(render(card())).not.toContain('lc-seat__reported');
  });
});

describe('TeamCard — allowance is not on the card (ADR 744)', () => {
  const now = 1_000_000;
  const allowance = {
    readAt: now,
    accounts: [
      {
        provider: 'claude' as const,
        label: 'Claude Max',
        readAt: now,
        windows: [{ name: '5h', left: 0.1, resetsAt: 1, kind: 'percent' as const }],
      },
    ],
  };

  it('paints no what-is-left line for an agent or a human: it lives in the header', () => {
    expect(render(card({ allowance }), { now })).not.toContain('Claude Max');
    expect(render(card({ kind: 'human', allowance }), { now })).not.toContain('Claude Max');
  });
});
