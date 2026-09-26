import { describe, expect, it } from 'vitest';
import { diffArrivals, newArrivalsCorner, type ArrivalSubject } from './arrivals';

const m = (name: string, over: Partial<ArrivalSubject> = {}): ArrivalSubject => ({
  name,
  kind: 'human',
  service: false,
  presence: 'offline',
  offline_reason: 'unknown',
  hue: 40,
  created_at: 1_000,
  sponsored_by: null,
  ...over,
});
const map = (xs: ArrivalSubject[]) => new Map(xs.map((x) => [x.name, x]));

describe('diffArrivals (lane 01M3F81DD9)', () => {
  it('the first roster the scene sees is never an arrival', () => {
    expect(diffArrivals(null, [m('nick'), m('ada')])).toEqual([]);
  });

  it('a name that was not there before is created — offline', () => {
    expect(diffArrivals(map([m('nick')]), [m('nick'), m('ada', { sponsored_by: 'nick' })])).toEqual([
      { kind: 'created', name: 'ada', memberKind: 'human', hue: 40, sponsor: 'nick', online: false },
    ]);
  });

  it('created and already online folds into one arrival with online: true', () => {
    const out = diffArrivals(map([m('nick')]), [
      m('nick'),
      m('guest1', { presence: 'online', offline_reason: null }),
    ]);
    expect(out).toEqual([
      { kind: 'created', name: 'guest1', memberKind: 'human', hue: 40, sponsor: null, online: true },
    ]);
  });

  it('never-connected going online is firstOnline', () => {
    const out = diffArrivals(map([m('ada')]), [m('ada', { presence: 'online', offline_reason: null })]);
    expect(out).toEqual([
      { kind: 'firstOnline', name: 'ada', memberKind: 'human', hue: 40, sponsor: null, online: true },
    ]);
  });

  it('a reconnect (previously disconnected) is not an arrival', () => {
    const out = diffArrivals(map([m('ada', { offline_reason: 'disconnected' })]), [
      m('ada', { presence: 'online', offline_reason: null }),
    ]);
    expect(out).toEqual([]);
  });

  it('away → online is not an arrival', () => {
    const out = diffArrivals(map([m('ada', { presence: 'away', offline_reason: null })]), [
      m('ada', { presence: 'online', offline_reason: null }),
    ]);
    expect(out).toEqual([]);
  });

  it('services never arrive', () => {
    expect(diffArrivals(map([]), [m('sweep', { kind: 'agent', service: true })])).toEqual([]);
  });

  it('agents carry memberKind agent', () => {
    expect(diffArrivals(map([]), [m('bot', { kind: 'agent' })])[0]?.memberKind).toBe('agent');
  });
});

describe('newArrivalsCorner', () => {
  const now = 100 * 3_600_000;
  it('lists deskless Members created in the last 24 h, newest first, at most 3', () => {
    const nodes = [
      m('a', { created_at: now - 1_000 }),
      m('b', { created_at: now - 2_000 }),
      m('c', { created_at: now - 3_000 }),
      m('d', { created_at: now - 4_000 }),
      m('old', { created_at: now - 25 * 3_600_000 }),
      m('seated', { created_at: now - 500 }),
      m('svc', { created_at: now - 100, service: true }),
      m('gone', { created_at: now - 100, offline_reason: 'left_team' }),
    ];
    expect(newArrivalsCorner(nodes, new Set(['seated']), now).map((p) => p.name)).toEqual([
      'a',
      'b',
      'c',
    ]);
  });
});
