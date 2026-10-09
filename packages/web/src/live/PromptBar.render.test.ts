import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { PromptBar } from './PromptBar';

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
