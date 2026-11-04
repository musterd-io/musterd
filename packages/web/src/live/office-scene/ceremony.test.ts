import { describe, expect, it } from 'vitest';

import { createCeremonies, FULL_WAITING, STALE_MS, STRIKE_GAP_MS } from './ceremony';

const goal = (id: string, at = 0, who = 'nick') => ({ id, who, at });

describe('the goal bell queue (lane 01M6HHHA96)', () => {
  it('plays one ceremony at a time, in the order the goals shipped', () => {
    const q = createCeremonies();
    q.push(goal('a'));
    q.push(goal('b', 0, 'ada'));
    expect(q.next(10)).toEqual({ goal: 'a', ringer: 'nick' });
    expect(q.next(20)).toBeNull(); // a is still playing
    q.done();
    expect(q.next(30)).toEqual({ goal: 'b', ringer: 'ada' });
    q.done();
    expect(q.next(40)).toBeNull();
  });

  it('plays the same goal once', () => {
    const q = createCeremonies();
    q.push(goal('a'));
    q.push(goal('a'));
    expect(q.next(0)).not.toBeNull();
    q.done();
    expect(q.next(1)).toBeNull();
  });

  it('drops a goal that waited too long, so a tab coming back plays no backlog', () => {
    const q = createCeremonies();
    q.push(goal('old', 0));
    q.push(goal('new', STALE_MS));
    expect(q.next(STALE_MS + 1)).toEqual({ goal: 'new', ringer: 'nick' });
  });

  it('past the third waiting, a goal rings the bell alone, spaced out, while one plays', () => {
    const q = createCeremonies();
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) q.push(goal(id));
    expect(q.next(0)).toEqual({ goal: 'a', ringer: 'nick' }); // five wait: b c d full, e f strike
    expect(q.next(1)).toBe('strike');
    expect(q.next(2)).toBeNull(); // too soon after the last strike
    expect(q.next(1 + STRIKE_GAP_MS)).toBe('strike');
    expect(q.next(2 + 2 * STRIKE_GAP_MS)).toBeNull(); // only FULL_WAITING left, waiting their turn
    for (const id of ['b', 'c', 'd'].slice(0, FULL_WAITING)) {
      q.done();
      expect(q.next(3 + 2 * STRIKE_GAP_MS)).toEqual({ goal: id, ringer: 'nick' });
    }
  });
});
