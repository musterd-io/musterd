import { PROTOCOL_VERSION, type Envelope, type MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StreamAskBanner } from './StreamAskBanner';

/** The stream's banner says what /live's says, and offers nothing to press (ADR 464 follow-up). */

const roster = [
  { name: 'nick', kind: 'human' },
  { name: 'izzo', kind: 'agent' },
] as unknown as MemberSummary[];

const ask = (id: string, body: string, agoMs = 1_000): Envelope =>
  ({
    id,
    v: PROTOCOL_VERSION,
    team: 'revive',
    from: 'izzo',
    to: { kind: 'member', name: 'nick' },
    act: 'ask',
    body,
    thread: null,
    meta: { species: 'approve', tier: 'blocking' },
    ts: Date.now() - agoMs,
  }) as Envelope;

const render = (envelopes: Envelope[]) =>
  renderToStaticMarkup(createElement(StreamAskBanner, { envelopes, roster }));

describe('StreamAskBanner', () => {
  it('idle: the quiet pill', () => {
    const html = render([]);
    expect(html).toContain('lc-asks--idle');
    expect(html).toContain('no open questions');
  });

  it('open: the asker, the human, the question and the hold — and no button anywhere', () => {
    const html = render([ask('a1', 'may I merge the OAuth change?')]);
    expect(html).toContain('lc-asks--open');
    expect(html).toContain('izzo');
    expect(html).toContain('is asking <b>nick</b>');
    expect(html).toContain('may I merge the OAuth change?');
    expect(html).toContain('holding until answered');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Approve');
  });

  it('says how many more are waiting, as words rather than a control', () => {
    const html = render([ask('a1', 'first'), ask('a2', 'second', 2_000), ask('a3', 'third', 3_000)]);
    expect(html).toContain('+2 more waiting');
    expect(html).not.toContain('<button');
  });
});
