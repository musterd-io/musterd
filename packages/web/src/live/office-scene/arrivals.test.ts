import { describe, expect, it } from 'vitest';
import { diffArrivals, type ArrivalSubject } from './arrivals';

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

describe('diffArrivals — a lapsed presence is not a first arrival (lane 01M3F81DD9, e2e 2026-09-26)', () => {
  // A member present only through CLI/HTTP calls (ambient presence, ADR 057) lapses to offline with
  // offline_reason `unknown` — the same value as never-connected. Found on a throwaway daemon: nick,
  // who had been active a minute earlier, was welcomed as "joined the team" on their next command.
  const now = 10 * 3_600_000;
  const fresh = (name: string, over: Partial<ArrivalSubject> = {}) => m(name, { created_at: now - 60_000, ...over });

  it('someone this viewer has already seen online does not arrive for the first time again', () => {
    const out = diffArrivals(map([fresh('nick')]), [fresh('nick', { presence: 'online', offline_reason: null })], {
      now,
      seenOnline: new Set(['nick']),
    });
    expect(out).toEqual([]);
  });

  it('a never-connected Member created more than 24 h ago is not a newcomer', () => {
    const old = m('delta', { created_at: now - 25 * 3_600_000 });
    const out = diffArrivals(map([old]), [{ ...old, presence: 'online', offline_reason: null }], {
      now,
      seenOnline: new Set(),
    });
    expect(out).toEqual([]);
  });

  it('a Member created today and never seen online still gets their welcome', () => {
    const out = diffArrivals(map([fresh('ada')]), [fresh('ada', { presence: 'online', offline_reason: null })], {
      now,
      seenOnline: new Set(),
    });
    expect(out.map((a) => [a.kind, a.name])).toEqual([['firstOnline', 'ada']]);
  });
});
