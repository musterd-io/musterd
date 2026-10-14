import { describe, expect, it } from 'vitest';

import {
  DAY_EDGE_COUNT,
  DAY_EDGE_PATHS,
  DAY_ROUTE_LENGTH,
  edgeLitFor,
  legAfterArrival,
} from './DayInTheLife';

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

// The pill boxes in viewBox units, measured in headless Chrome at 1024, 1440 and 1920 px (identical at all
// three: the pills scale with the graph). Re-measure if a pill's label, padding or font changes.
const PILLS: Record<string, [number, number, number, number]> = {
  join: [11, 56, 149, 104],
  orient: [193, 56, 323, 104],
  claim: [364, 56, 486, 104],
  build: [536, 56, 654, 104],
  inbox: [533, 276, 657, 324],
  mate: [743, 276, 977, 324],
  admin: [766, 56, 958, 104],
  ready: [230, 181, 460, 229],
  review: [527, 456, 663, 504],
  wrap: [176, 431, 324, 479],
};
const gap = ([x, y]: number[], [x0, y0, x1, y1]: [number, number, number, number]) =>
  Math.hypot(Math.max(x0 - x!, 0, x! - x1), Math.max(y0 - y!, 0, y! - y1));

describe('day in the life: every arrow meets its pill', () => {
  it.each(DAY_EDGE_PATHS.map((d, i) => [i, d] as const))(
    'edge %i starts and ends just outside a pill',
    (_, d) => {
      const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number);
      for (const pt of [nums.slice(0, 2), nums.slice(-2)]) {
        const nearest = Math.min(...Object.values(PILLS).map((b) => gap(pt, b)));
        expect(nearest).toBeGreaterThanOrEqual(4); // not under a pill, where the arrowhead hides
        expect(nearest).toBeLessThanOrEqual(14); // not short of it, pointing at nothing
      }
    },
  );
});
