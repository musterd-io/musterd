import type { Envelope, MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { composerOpenFrom, PromptBar } from './PromptBar';
import { deriveAsks } from './asks';
import { REPLY_FOOTER } from './promptAct';

const m = (name: string, kind: string, presence = 'online') =>
  ({ name, kind, presence, hue: 200 }) as unknown as MemberSummary;
const roster = [
  m('nick', 'human'),
  m('dolly', 'agent'),
  m('ghost', 'agent', 'offline'),
  m('izzo', 'agent'),
  m('sloane', 'agent'),
  m('stanley', 'agent', 'offline'),
  m('wanderer', 'agent'),
  m('relay', 'service'),
];
const html = renderToStaticMarkup(
  createElement(PromptBar, {
    cfg: { team: 'revive', as: 'nick', token: 'mscr_x' },
    roster,
    viewer: 'nick',
    envelopes: [],
    asks: [],
    onSent: () => {},
  }),
);

describe('PromptBar — the composer', () => {
  it('speaks alfie’s copy and nothing about huddles, acts or a cast', () => {
    expect(html).toContain('placeholder="Ask your team anything"');
    expect(html).toContain('@ to pick who');
    expect(html).toContain('>@team<');
    expect(html).not.toMatch(/huddle|envelope|\bact\b|cast|who hears it/i);
  });

  it('shows the team listening as faces — not the four demo seats as buttons', () => {
    expect(html).not.toContain('aria-pressed');
    expect(html.match(/class="mface"/g)?.length).toBe(5); // five faces, then +N
    expect(html).toContain('+1');
    expect(html).not.toContain('aria-label="nick"'); // the viewer is not in their own audience
    expect(html).not.toContain('aria-label="relay"'); // services are not the team
  });

  it('has a send button that is disabled until there is text', () => {
    expect(html).toMatch(/<button[^>]*class="pbar__send"[^>]*disabled=""/);
  });
});

describe('collapse and expand (nick, 2026-10-09)', () => {
  it('starts open, with a control to collapse it', () => {
    expect(html).toContain('aria-label="Collapse the chat bar"');
    expect(html).toContain('class="pbar__input"');
  });

  it('remembers the reader’s choice, and opens when it cannot read one', () => {
    const store = (v: string | null) => ({ getItem: () => v, setItem: () => {} });
    expect(composerOpenFrom(store('closed'))).toBe(false);
    expect(composerOpenFrom(store('open'))).toBe(true);
    expect(composerOpenFrom(store(null))).toBe(true);
    expect(composerOpenFrom(null)).toBe(true);
    const throws = { getItem: () => { throw new Error('private mode'); }, setItem: () => {} };
    expect(composerOpenFrom(throws)).toBe(true);
  });
});

describe('the @-picker (nick: "shouldnt it close automatically?")', () => {
  it('has no Done button — picking a member closes it', async () => {
    const src = (await import('node:fs')).readFileSync(new URL('./PromptBar.tsx', import.meta.url), 'utf8');
    expect(src).not.toContain('pbar__done');
    const toggle = src.slice(src.indexOf('const toggle ='), src.indexOf('const box ='));
    expect(toggle).toContain('setPicking(false)');
  });
});

describe('the thread panel (lane 01M4KY55N1)', () => {
  const t0 = Date.now() - 60_000;
  const env = (over: Partial<Envelope> & Pick<Envelope, 'id' | 'from'>): Envelope =>
    ({
      team: 'revive',
      to: { kind: 'member', name: 'nick' },
      act: 'message',
      body: '',
      thread: null,
      meta: null,
      ts: t0,
      ...over,
    }) as Envelope;
  const root = env({
    id: 'root',
    from: 'nick',
    to: { kind: 'team' },
    body: `Plan the first ten minutes\n\n${REPLY_FOOTER}`,
    meta: { huddle: { topic: { kind: 'design', id: 'demo' } }, eligible: ['dolly', 'ghost', 'stanley'] },
  });
  const render = (envelopes: Envelope[]) =>
    renderToStaticMarkup(
      createElement(PromptBar, {
        cfg: { team: 'revive', as: 'nick', token: 'mscr_x' },
        roster,
        viewer: 'nick',
        envelopes,
        asks: deriveAsks(envelopes),
        onSent: () => {},
      }),
    );

  it('is absent until the viewer has sent something', () => {
    expect(html).not.toContain('class="cthread');
  });

  it('opens with the sentence as typed, and nobody has answered yet', () => {
    const out = render([root]);
    expect(out).toContain('Plan the first ten minutes');
    expect(out).not.toContain('Reply in this thread'); // the routing footer is plumbing
    expect(out).toContain('0 of 3 have answered');
  });

  it('says waking… while an asleep seat has not answered', () => {
    const out = render([root]);
    expect(out).toContain('waking…');
    expect(out).toMatch(/class="cseat is-waking"[^>]*title="ghost — waking…"/);
    expect(out).toMatch(/class="cseat is-here"[^>]*title="dolly"/);
  });

  it('counts a reply by thread or by in_reply_to, and ticks who answered', () => {
    const out = render([
      root,
      env({ id: 'r1', from: 'dolly', thread: 'root', body: 'On it.', ts: t0 + 5_000, meta: { model: 'claude-opus-5-5' } }),
      env({ id: 'r2', from: 'ghost', body: 'Woke up for this.', ts: t0 + 54_000, meta: { in_reply_to: 'root' } }),
    ]);
    expect(out).toContain('2 of 3 have answered');
    expect(out).toContain('On it.');
    expect(out).toContain('Opus 5.5');
    expect(out).toContain('Woke up for this.');
    expect(out.match(/class="cseat__tick"/g)?.length).toBe(2); // dolly + ghost
    expect(out).toContain('waking…'); // stanley still is
  });

  it('puts an ask to the viewer inline, with the three answers', () => {
    const out = render([
      root,
      env({ id: 'a1', from: 'wanderer', act: 'ask', thread: 'root', body: 'Ship the port fix today?', ts: t0 + 9_000, meta: { species: 'approve', tier: 'standard' } }),
    ]);
    expect(out).toContain('needs your approval');
    expect(out).toContain('Ship the port fix today?');
    expect(out).toContain('>Approve<');
    expect(out).toContain('>Deny<');
    expect(out).toContain('>Deciding — 1h<');
  });
});
