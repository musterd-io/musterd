import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Stream } from './Stream';

/**
 * What the stream row actually RENDERS for an act addressed to several people.
 *
 * The pure readers (`recipientScope` / `recipientNames`, covered in `format.test.ts`) can be
 * perfectly right while the row still paints "team" over an act addressed to named seats, because
 * the mapping from scope to markup lives in the component — and that is exactly the state /live was
 * in until 2026-09-02: the CLI printed `ryder | sloane`, the office scene walked to both desks, and
 * the panel a reader actually scans said "team". This file holds the wiring the readers cannot.
 *
 * Rendered with `react-dom/server` and no DOM, for the reasons `AsksStrip.render.test.ts` sets out:
 * no jsdom, no testing-library, no headless Chromium on a laptop that feels it. Effects never run,
 * so every claim here is a render-time one — which is all the recipient pill is.
 */

const roster = [
  { name: 'nick', kind: 'human' },
  { name: 'ryder', kind: 'agent' },
  { name: 'sloane', kind: 'agent' },
  { name: 'dolly', kind: 'agent' },
] as unknown as MemberSummary[];

const env = (over: Partial<Envelope>): Envelope =>
  ({
    id: '01ROW',
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'nick',
    to: { kind: 'team' },
    act: 'request_help',
    body: 'Review please',
    thread: null,
    meta: null,
    ts: Date.now(),
    ...over,
  }) as Envelope;

const render = (e: Envelope) =>
  renderToStaticMarkup(
    createElement(Stream, { envelopes: [e], roster, liveIds: new Set<string>() }),
  );

describe('the stream row names an eligible set instead of calling it a team act', () => {
  it('lists every seat of the set, joined by "or"', () => {
    const html = render(env({ meta: { eligible: ['ryder', 'sloane'] } }));
    expect(html).toContain('ryder');
    expect(html).toContain('sloane');
    expect(html).toContain('lc-to--eligible');
    expect(html).toContain('>or<');
    // It must NOT fall back to the anonymous team pill — that was the whole defect.
    expect(html).not.toContain('lc-to--team');
  });

  it('carries all four at the MAX_ELIGIBLE cap', () => {
    const html = render(env({ meta: { eligible: ['ryder', 'sloane', 'dolly', 'nick'] } }));
    for (const n of ['ryder', 'sloane', 'dolly']) expect(html).toContain(n);
    // Three joiners for four seats — a dropped name would show as two.
    expect(html.match(/>or</g)?.length).toBe(3);
  });

  it('still renders a plain team act as team', () => {
    const html = render(env({ meta: null }));
    expect(html).toContain('lc-to--team');
    expect(html).not.toContain('lc-to--eligible');
  });

  it('leaves a direct 1:1 exactly as it was — one name, no joiner', () => {
    const html = render(env({ to: { kind: 'member', name: 'ryder' } }));
    expect(html).toContain('lc-to--direct');
    expect(html).not.toContain('lc-to--eligible');
    expect(html).not.toContain('>or<');
  });

  it('treats a one-name set as a team act, not a set of one', () => {
    // A single-name "set" is a member act that took the wrong road; naming it would assert a
    // routing fact the ledger does not have.
    const html = render(env({ meta: { eligible: ['ryder'] } }));
    expect(html).toContain('lc-to--team');
    expect(html).not.toContain('lc-to--eligible');
  });
});

describe('a huddle reads as one card in the stream, at its latest turn', () => {
  const HUDDLE = { topic: { kind: 'goal', id: 'demo' }, room: 'https://b.example/h', anchor: 'docs/x.md' };
  const t0 = Date.UTC(2026, 9, 1, 18, 0, 0);
  const timeline = [
    env({ id: '01ROOT', from: 'nick', act: 'message', body: 'Which Replay lane?', ts: t0, meta: { huddle: HUDDLE } }),
    env({ id: '01PLAIN', from: 'ryder', act: 'status_update', body: 'shipping the picker', ts: t0 + 30_000 }),
    env({ id: '01T1', from: 'sloane', act: 'message', body: 'Lane 2, scrubber.', ts: t0 + 84_000, thread: '01ROOT' }),
    env({ id: '01LATE', from: 'dolly', act: 'status_update', body: 'unrelated', ts: t0 + 90_000 }),
    env({ id: '01T2', from: 'ryder', act: 'message', body: 'Lane 1, the engine.', ts: t0 + 150_000, thread: '01ROOT' }),
  ];
  const html = renderToStaticMarkup(
    createElement(Stream, { envelopes: timeline, roster, liveIds: new Set<string>() }),
  );

  it('draws one card, after the last unrelated row that came before its latest turn', () => {
    expect(html.match(/class="lc-hcard[ "]/g)).toHaveLength(1);
    expect(html.indexOf('lc-hcard')).toBeGreaterThan(html.indexOf('unrelated'));
  });

  it('folds the root and its turns out of the plain rows', () => {
    expect(html).not.toContain('id="lc-msg-01ROOT" class="lc-row');
    expect(html).not.toContain('id="lc-msg-01T1" class="lc-row');
    expect(html).toContain('shipping the picker');
  });

  it('gives every turn time-to-turn and a reveal target', () => {
    expect(html).toContain('id="lc-msg-01T1"');
    expect(html).toContain('+1.4m');
    expect(html).toContain('+2.5m');
    expect(html).toContain('Lane 1, the engine.');
  });

  it('counts the turns in its header', () => {
    expect(html).toContain('2 turns');
  });
});

describe('the huddle card reads at a glance (polish)', () => {
  const HUDDLE = { topic: { kind: 'goal', id: 'demo' }, room: 'https://b.example/h', anchor: 'docs/x.md' };
  const t0 = Date.UTC(2026, 9, 1, 18, 0, 0);
  const root = env({ id: '01R', from: 'nick', act: 'message', body: 'Pick a lane.', ts: t0, to: { kind: 'team' }, meta: { huddle: HUDDLE, eligible: ['sloane', 'ryder', 'dolly'] } });
  const turn = env({ id: '01T', from: 'sloane', act: 'message', body: 'Lane 2.', ts: t0 + 60_000, thread: '01R' });
  const render = (envs: Envelope[]) =>
    renderToStaticMarkup(createElement(Stream, { envelopes: envs, roster, liveIds: new Set<string>() }));

  it('splits the topic into its kind and its name instead of printing goal:demo', () => {
    const html = render([root, turn]);
    expect(html).not.toContain('goal:demo');
    expect(html).toContain('lc-hcard__kind">goal<');
    expect(html).toContain('>demo<');
  });

  it('shows who is still expected as empty seats, so the room visibly fills', () => {
    const html = render([root, turn]);
    expect(html.match(/lc-hcard__waiting-seat/g)).toHaveLength(2);
    expect(html).toContain('yet to speak');
  });

  it('marks an open room live, and a closed one not', () => {
    expect(render([root, turn])).toContain('lc-hcard__live');
    const closed = env({ id: '01X', from: 'nick', act: 'resolve', body: 'done', ts: t0 + 90_000, thread: '01R' });
    expect(render([root, turn, closed])).not.toContain('lc-hcard__live');
  });
});
