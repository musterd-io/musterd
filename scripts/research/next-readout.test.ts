import { describe, expect, it } from 'vitest';
import {
  classify,
  matchPickups,
  PICKUP_WINDOW_MS,
  share,
  summarise,
  type ClaimRow,
  type OfferRow,
} from './next-readout.js';

/**
 * ADR 536 increment 3 — the join and the verdict on hand-made rows. What this guards: a claim counts
 * against the actor's NEWEST offer inside the hour (never another seat's, never a later one), a
 * handoff is not a pickup, the baseline is scored on the same claims, and the verdict abstains
 * under five.
 */
const T0 = Date.UTC(2026, 9, 7, 12);
const offer = (over: Partial<OfferRow> & { ts: number; actor: string }): OfferRow => ({
  offered: [],
  baseline: [],
  total: 0,
  blocked_total: 0,
  ...over,
});
const claim = (ts: number, actor: string, lane: string): ClaimRow => ({ ts, actor, lane });

describe('matchPickups', () => {
  it('joins a claim to the same actor’s newest offer within the hour, with both ranks and the tier', () => {
    const older = offer({
      ts: T0 - 50 * 60_000,
      actor: 'lazara',
      offered: [{ lane: 'A', tier: 5 }],
      baseline: ['A'],
    });
    const newer = offer({
      ts: T0 - 10 * 60_000,
      actor: 'lazara',
      offered: [
        { lane: 'B', tier: 2 },
        { lane: 'A', tier: 5 },
      ],
      baseline: ['A', 'C'],
    });
    const [p] = matchPickups([older, newer], [claim(T0, 'lazara', 'A')]);
    expect(p!.offer).toBe(newer);
    expect(p!.ranked_rank).toBe(2);
    expect(p!.baseline_rank).toBe(1);
    expect(p!.tier).toBe(5);
  });

  it('ignores another seat’s offer, an offer after the claim, and one older than the window', () => {
    const offers = [
      offer({ ts: T0 - 60_000, actor: 'ghost', offered: [{ lane: 'A', tier: 1 }] }),
      offer({ ts: T0 + 60_000, actor: 'lazara', offered: [{ lane: 'A', tier: 1 }] }),
      offer({ ts: T0 - PICKUP_WINDOW_MS - 1, actor: 'lazara', offered: [{ lane: 'A', tier: 1 }] }),
    ];
    const [p] = matchPickups(offers, [claim(T0, 'lazara', 'A')]);
    expect(p!.offer).toBeNull();
    expect(p!.ranked_rank).toBeNull();
    expect(p!.baseline_rank).toBeNull();
  });

  it('an offered lane the seat did not claim, and a claimed lane not offered, are both misses', () => {
    const o = offer({
      ts: T0 - 1,
      actor: 'lazara',
      offered: [{ lane: 'A', tier: 3 }],
      baseline: ['B'],
    });
    const [p] = matchPickups([o], [claim(T0, 'lazara', 'Z')]);
    expect(p!.offer).toBe(o);
    expect(p!.ranked_rank).toBeNull();
    expect(p!.baseline_rank).toBeNull();
    expect(p!.tier).toBeNull();
  });
});

describe('summarise', () => {
  const o = (actor: string, ts: number) =>
    offer({
      ts,
      actor,
      offered: [
        { lane: 'R1', tier: 2 },
        { lane: 'R2', tier: 4 },
      ],
      baseline: ['B1', 'R2'],
      total: 30,
      blocked_total: 44,
    });

  it('counts hits by rank for both orders, the tier yield, and window honesty', () => {
    const offers = [o('a', T0 - 1), o('b', T0 - 1), offer({ ts: T0, actor: 'c', total: 3 })];
    const claims = [
      claim(T0, 'a', 'R1'), // ranked hit rank 1, tier 2; baseline miss
      claim(T0, 'b', 'R2'), // ranked hit rank 2, tier 4; baseline hit rank 2
      claim(T0, 'c', 'B1'), // offer with nothing offered: miss both
      claim(T0, 'z', 'R1'), // no offer at all
    ];
    const r = summarise(offers, matchPickups(offers, claims));
    expect(r.offers).toBe(3);
    expect(r.offers_deeper_than_window).toBe(2);
    expect(r.claims).toBe(4);
    expect(r.claims_with_offer).toBe(3);
    expect(r.ranked_hits).toBe(2);
    expect(r.baseline_hits).toBe(1);
    expect(r.ranked_by_rank).toEqual([1, 1, 0, 0, 0]);
    expect(r.baseline_by_rank).toEqual([0, 1, 0, 0, 0]);
    expect(r.tier_yield).toEqual([0, 0, 1, 0, 1, 0]);
  });

  it('abstains under five claims with an offer; above it the verdict is ranked > baseline', () => {
    const few = summarise([], matchPickups([], []));
    expect(few.verdict).toBe('insufficient');
    const offers = Array.from({ length: 5 }, (_, i) => o(`s${String(i)}`, T0 - 1));
    const wins = offers.map((x) => claim(T0, x.actor, 'R1'));
    expect(summarise(offers, matchPickups(offers, wins)).verdict).toBe('not-met');
    // Every claim in BOTH windows: equal hits, the falsifier fires (at or below).
    const ties = offers.map((x) => claim(T0, x.actor, 'R2'));
    expect(summarise(offers, matchPickups(offers, ties)).verdict).toBe('met');
  });
});

describe('classify / share', () => {
  it('reads an offer row and a claim row; a handoff or a torn detail is nothing', () => {
    expect(
      classify({
        ts: 1,
        actor: 'a',
        action: 'next.offer',
        detail: JSON.stringify({
          offered: [{ lane: 'L', tier: 1 }],
          baseline: ['L'],
          total: 7,
          blocked_total: 2,
        }),
      }),
    ).toEqual({
      offer: {
        ts: 1,
        actor: 'a',
        offered: [{ lane: 'L', tier: 1 }],
        baseline: ['L'],
        total: 7,
        blocked_total: 2,
      },
    });
    expect(
      classify({
        ts: 2,
        actor: 'a',
        action: 'lane.claimed',
        detail: JSON.stringify({ lane: 'L', kind: 'claim' }),
      }),
    ).toEqual({ claim: { ts: 2, actor: 'a', lane: 'L' } });
    expect(
      classify({
        ts: 3,
        actor: 'a',
        action: 'lane.claimed',
        detail: JSON.stringify({ lane: 'L', kind: 'handoff' }),
      }),
    ).toBeNull();
    expect(classify({ ts: 4, actor: 'a', action: 'next.offer', detail: '{not json' })).toBeNull();
    expect(classify({ ts: 5, actor: null, action: 'next.offer', detail: '{}' })).toBeNull();
  });

  it('prints a percentage only at n ≥ 5', () => {
    expect(share(2, 4)).toBe('2 of 4');
    expect(share(2, 5)).toBe('2 of 5 (40%)');
    expect(share(0, 0)).toBe('0 of 0');
  });
});
