import { describe, expect, it } from 'vitest';
import {
  APP_MEMBER_STATES,
  AppDeliverySchema,
  AppForYouSchema,
  AppMemberSchema,
} from './appChannel.js';

describe('the app roster (ADR 791)', () => {
  const roster = (seat: Record<string, unknown>) => ({
    v: 1,
    kind: 'roster',
    team: 'revive',
    binding: 'b1',
    ts: 1,
    seats: [{ seat: 'ryder', online: false, wakeable: true, lane: null, ...seat }],
  });

  it('a seat may say who it waits on, and since when (ADR 806)', () => {
    const waiting = { to: 'nick', since: 1793826651146 };
    const parsed = AppDeliverySchema.parse(roster({ waiting }));
    expect(parsed.kind === 'roster' && parsed.seats[0]?.waiting).toEqual(waiting);
    // A question to the team names no one.
    expect(AppDeliverySchema.safeParse(roster({ waiting: { to: null, since: 1 } })).success).toBe(
      true,
    );
    // An older daemon sends no `waiting`; the seat still parses.
    expect(AppDeliverySchema.safeParse(roster({})).success).toBe(true);
    expect(AppDeliverySchema.safeParse(roster({ waiting: { to: 'nick' } })).success).toBe(false);
  });
});

describe('the roster carries the team as /live shows it (ADR 814)', () => {
  const member = (over: Record<string, unknown> = {}) => ({
    name: 'lazara',
    kind: 'agent',
    state: 'working',
    label: 'working on',
    title: 'Rider 8 run',
    source: 'lane',
    goal: 'coordination-cost',
    since: 1793826651146,
    more_lanes: 1,
    model: 'opus 5.5',
    online: true,
    wakeable: true,
    lane: { id: 'L1', title: 'Rider 8 run' },
    portrait: null,
    ...over,
  });
  const roster = (over: Record<string, unknown> = {}) => ({
    v: 1,
    kind: 'roster',
    team: 'revive',
    binding: 'b1',
    ts: 1,
    seats: [],
    ...over,
  });

  it('accepts every /live state and refuses the Seats screen’s old words', () => {
    for (const state of APP_MEMBER_STATES)
      expect(AppMemberSchema.safeParse(member({ state })).success).toBe(true);
    expect(AppMemberSchema.safeParse(member({ state: 'online' })).success).toBe(false);
    expect(AppMemberSchema.safeParse(member({ more_lanes: -1 })).success).toBe(false);
  });

  it('holds at most 64 members and 32 for-you items', () => {
    const many = (n: number) => Array.from({ length: n }, (_, i) => member({ name: `m${i}` }));
    expect(AppDeliverySchema.safeParse(roster({ members: many(64) })).success).toBe(true);
    expect(AppDeliverySchema.safeParse(roster({ members: many(65) })).success).toBe(false);
    const fy = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `a${i}`,
        from: 'miley',
        kind: 'approve',
        summary: 'Merge?',
        ts: 1,
      }));
    expect(AppDeliverySchema.safeParse(roster({ for_you: fy(32) })).success).toBe(true);
    expect(AppDeliverySchema.safeParse(roster({ for_you: fy(33) })).success).toBe(false);
  });

  it('cuts a for-you summary at 200 characters', () => {
    const item = { id: 'a', from: 'miley', kind: 'question', summary: 'x'.repeat(200), ts: 1 };
    expect(AppForYouSchema.safeParse(item).success).toBe(true);
    expect(AppForYouSchema.safeParse({ ...item, summary: 'x'.repeat(201) }).success).toBe(false);
  });

  it('still parses a roster from a daemon that sends neither field', () => {
    expect(AppDeliverySchema.safeParse(roster()).success).toBe(true);
  });
});
