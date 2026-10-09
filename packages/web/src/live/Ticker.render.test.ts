import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LogDrawer } from './LogDrawer';
import { Ticker } from './Ticker';
import { TopMeter } from './TopMeter';

const MIN = 60_000;
const env = (ts: number, over: Partial<Envelope> = {}): Envelope =>
  ({
    id: `e${ts}`,
    team: 'revive',
    from: 'ryder',
    to: { kind: 'team' },
    act: 'message',
    body: '',
    ts,
    meta: null,
    ...over,
  }) as Envelope;
const m = (name: string, over: Partial<MemberSummary> = {}): MemberSummary =>
  ({
    id: `m_${name}`,
    name,
    kind: 'agent',
    presence: 'online',
    posture: 'working',
    presences: [],
    capabilities: {},
    hue: 200,
    ...over,
  }) as unknown as MemberSummary;
const board = {
  lanes: [{ id: 'L9', title: 'Grok hook fix' }],
  warnings: [],
} as unknown as LaneBoard;

describe('Ticker', () => {
  it('shows the newest notable moments first, each in its actor hue, and never the body', () => {
    const html = renderToStaticMarkup(
      createElement(Ticker, {
        roster: [m('ryder'), m('dolly', { hue: 20 })],
        board,
        envelopes: [
          env(1, { act: 'status_update', body: 'PRIVATE STATUS' }),
          env(2, {
            act: 'handoff',
            to: { kind: 'member', name: 'dolly' },
            meta: { lane_handoff: { lane: 'L9', branch: 'b' } },
            body: 'SECRET',
          }),
          env(3, { from: 'dolly', act: 'accept', to: { kind: 'member', name: 'ryder' } }),
        ],
      }),
    );
    expect(html.indexOf("dolly accepted ryder's work")).toBeLessThan(
      html.indexOf('ryder handed Grok hook fix to dolly'),
    );
    expect(html).not.toContain('SECRET');
    expect(html).not.toContain('PRIVATE STATUS');
    expect(html).toContain('--member:hsl(');
    // The log's door moved to the topbar (live-briefing spec, increment 4).
    expect(html).not.toContain('See every message');
  });

  it('drops a moment the asks strip is already showing', () => {
    const ask = env(5, {
      id: 'ASK1',
      act: 'ask',
      to: { kind: 'member', name: 'nick' },
      body: 'Ship it?',
      meta: { species: 'approve', tier: 'blocking' },
    });
    const shown = (hide?: ReadonlySet<string>) =>
      renderToStaticMarkup(
        createElement(Ticker, {
          roster: [m('ryder')],
          board,
          envelopes: [ask],
          ...(hide ? { hide } : {}),
        }),
      );
    expect(shown()).toContain('Ship it?');
    expect(shown(new Set(['ASK1']))).not.toContain('Ship it?');
  });

  it('says so when nothing notable has happened yet', () => {
    expect(
      renderToStaticMarkup(createElement(Ticker, { roster: [], board: null, envelopes: [] })),
    ).toContain('Nothing notable yet');
  });
});

describe('TopMeter', () => {
  it('reads the team, the heartbeat (its age on hover), and the rate over the true span', () => {
    const now = 100 * MIN;
    const html = renderToStaticMarkup(
      createElement(TopMeter, {
        teamName: 'revive',
        now,
        roster: [
          m('a'),
          m('b', { posture: 'active' }),
          m('nick', { kind: 'human', posture: 'active' }),
        ],
        envelopes: [env(now - 40 * MIN), env(now - 3_000)],
      }),
    );
    expect(html).toContain('revive');
    expect(html).toContain('title="last act 3s ago"');
    expect(html).not.toContain('>last act');
    expect(html).toContain('2 acts');
    expect(html).toContain('last 40 min');
    expect(html).not.toContain('1 working');
    expect(html).toContain('<svg');
  });
});

describe('LogDrawer', () => {
  it('renders a labelled dialog with a close control around its content when open, nothing when shut', () => {
    const open = renderToStaticMarkup(
      createElement(LogDrawer, {
        open: true,
        onClose: () => {},
        title: 'Team log',
        children: 'THE STREAM',
      }),
    );
    expect(open).toMatch(/role="dialog"[^>]*aria-modal="true"[^>]*aria-label="Team log"/);
    expect(open).toContain('aria-label="Close the log"');
    expect(open).toContain('THE STREAM');
    expect(
      renderToStaticMarkup(
        createElement(LogDrawer, {
          open: false,
          onClose: () => {},
          title: 'Team log',
          children: 'x',
        }),
      ),
    ).toBe('');
  });
});
