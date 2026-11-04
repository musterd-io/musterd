import { describe, expect, it } from 'vitest';
import { AppDeliverySchema } from './appChannel.js';

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
