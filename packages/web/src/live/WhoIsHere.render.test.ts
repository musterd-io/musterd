import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LIVE_PAGE_WORKSPACE } from './client';
import { WhoIsHere } from './WhoIsHere';

const onLive = (name: string, kind: 'human' | 'agent') =>
  ({
    name,
    kind,
    presences: [{ surface: 'web', workspace: LIVE_PAGE_WORKSPACE, status: 'online', last_seen_at: 0 }],
  }) as unknown as MemberSummary;
const render = (roster: MemberSummary[], you: string | null) =>
  renderToStaticMarkup(createElement(WhoIsHere, { roster, you }));

describe('WhoIsHere (ADR 692)', () => {
  it('renders nothing when nobody has /live open', () => {
    expect(render([], null)).toBe('');
  });

  it('names who is here for a screen reader, the viewer last', () => {
    const html = render([onLive('nick', 'human'), onLive('Bo', 'human')], 'nick');
    expect(html).toContain('aria-label="On /live now: Bo, and you"');
    expect(html).toContain('aria-label="nick (you), person"');
  });

  it('shows nothing for one watcher, you or not, and appears at two (nick, 2026-10-28)', () => {
    expect(render([onLive('nick', 'human')], 'nick')).toBe('');
    expect(render([onLive('Ada', 'agent')], null)).toBe('');
    expect(render([onLive('Ada', 'agent'), onLive('nick', 'human')], 'nick')).toContain('agent session');
  });

  it('folds faces past five into a count that still names them', () => {
    const roster = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => onLive(n, 'human'));
    const html = render(roster, null);
    expect(html).toContain('+2');
    expect(html).toContain('aria-label="2 more: f, g"');
  });
});
