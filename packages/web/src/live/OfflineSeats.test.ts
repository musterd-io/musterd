import type { MemberSummary } from '@musterd/protocol';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { LiveConfig } from './client';
import { OfflineFold, OfflineSeats, canWake, outWord } from './OfflineSeats';

const m = (name: string, over: Partial<MemberSummary> = {}) =>
  ({ name, kind: 'agent', presence: 'offline', ...over }) as MemberSummary;

const members = [
  m('dolly'),
  m('nick', { kind: 'human' }),
  m('ryder', { wakeable: true }),
  m('sloane', { wakeable: true, wakeability: 'enrolled_host_stale' }),
];
const roster = new Map(members.map((x) => [x.name, x]));
const render = (canAct: boolean) =>
  renderToStaticMarkup(
    createElement(OfflineSeats, { members, roster, cfg: {} as LiveConfig, canAct }),
  );

describe('OfflineSeats (lane 01M6KZZ5WH)', () => {
  it('wakes only an agent the five-state read says a directed act can reach', () => {
    expect(canWake(members[2]!)).toBe(true);
    expect(canWake(members[3]!)).toBe(false);
    expect(canWake(members[1]!)).toBe(false);
  });

  it('says why each seat is out, plainly', () => {
    expect(members.map(outWord)).toEqual(['can’t be woken from here', 'away', 'asleep', 'its machine is quiet']);
  });

  it('lists the wakeable seats first, then other agents, then people', () => {
    const names = [...render(true).matchAll(/class="ofs__name">([^<]+)</g)].map((x) => x[1]);
    expect(names).toEqual(['ryder', 'dolly', 'sloane', 'nick']);
  });

  it('offers Start on the wakeable seat alone, and only to someone who may act', () => {
    const html = render(true);
    expect(html.match(/qa__btn--start/g)?.length).toBe(1);
    expect(render(false)).not.toContain('qa__btn--start');
  });
});

describe('OfflineFold', () => {
  const fold = (canAct: boolean) =>
    renderToStaticMarkup(
      createElement(OfflineFold, { roster: [m('fifty', { presence: 'online' }), ...members], cfg: {} as LiveConfig, canAct }),
    );
  it('is one closed control: faces, the count, and how many can start', () => {
    const html = fold(true);
    expect(html).toMatch(/<button type="button" class="lc-team__offline" aria-expanded="false"/);
    expect(html).toContain('4 offline');
    expect(html).toContain('1 can start');
    expect(html).not.toContain('class="ofs"');
  });
  it('never says "can start" to someone who may not act', () => {
    expect(fold(false)).not.toContain('can start');
  });
});
