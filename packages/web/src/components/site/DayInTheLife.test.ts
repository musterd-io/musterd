import { describe, expect, it } from 'vitest';

import { DAY_EDGE_COUNT, DAY_ROUTE_LENGTH, edgeLitFor, legAfterArrival } from './DayInTheLife';

const LOOP_LEG = DAY_ROUTE_LENGTH - 1;
const allEdges = Array.from({ length: DAY_EDGE_COUNT }, (_, i) => i);

describe('day in the life: the walk restarts clean after the loop', () => {
  it('the loop leg arrives at the start of the route, not at its end', () => {
    expect(legAfterArrival(LOOP_LEG)).toBe(-1);
  });

  it('any other leg keeps its index on arrival', () => {
    expect(legAfterArrival(0)).toBe(0);
    expect(legAfterArrival(LOOP_LEG - 1)).toBe(LOOP_LEG - 1);
  });

  it('resting at Join after the loop lights no edge (nick 2026-10-13: arrows floated with no nodes)', () => {
    const leg = legAfterArrival(LOOP_LEG);
    const lit = allEdges.filter((i) =>
      edgeLitFor(i, { still: false, looping: false, step: 0, leg }),
    );
    expect(lit).toEqual([]);
  });

  it('mid-day, the edges behind the walker stay lit', () => {
    const lit = allEdges.filter((i) =>
      edgeLitFor(i, { still: false, looping: false, step: 3, leg: 2 }),
    );
    expect(lit).toEqual([0, 1, 2]);
  });

  it('under reduced motion every edge is shown', () => {
    expect(
      allEdges.every((i) => edgeLitFor(i, { still: true, looping: false, step: 0, leg: -1 })),
    ).toBe(true);
  });
});
