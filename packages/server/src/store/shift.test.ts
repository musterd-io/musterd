import type { WorkingHours } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, listAuditByAction } from './audit.js';
import { addMember } from './members.js';
import type { MemberRow } from './rows.js';
import {
  getShift,
  settleEnding,
  shiftDay,
  shiftDayStart,
  shiftHours,
  shiftSpentUsd,
  shiftStateOf,
  shiftStopDue,
  startShift,
  stopShift,
  UNPRICED_WAKE_FALLBACK_USD,
} from './shift.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

const PACIFIC: WorkingHours = {
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '09:00',
  end: '18:00',
};
const at = (iso: string) => Date.parse(iso);
// Tuesday 2026-11-03, Pacific is UTC-8.
const TUE_NOON = at('2026-11-03T20:00:00Z');

withDrivers('shift store (ADR 792)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const ryder = (await addMember(db, team, { name: 'ryder', kind: 'agent' })).row;
    return { db, team, ryder };
  }

  async function leased(db: Driver, teamId: string, seat: string, leaseId: string, ts: number) {
    await appendAudit(db, teamId, {
      actor: null,
      action: 'residency.wake_leased',
      target: seat,
      result: 'allow',
      detail: { lease_id: leaseId },
    });
    await db.run(
      'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
      [ts],
    );
  }

  async function cost(
    db: Driver,
    teamId: string,
    seat: string,
    leaseId: string,
    usd: number,
    ts: number,
  ) {
    await appendAudit(db, teamId, {
      actor: null,
      action: 'residency.wake_cost',
      target: seat,
      result: 'allow',
      detail: { lease_id: leaseId, cost_usd: usd },
    });
    await db.run(
      'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
      [ts],
    );
  }

  it('start sets on and inside_hours, and audits who started it', async () => {
    const { db, team, ryder } = await seed();
    const row = await startShift(db, team.id, ryder, 'nick', PACIFIC, TUE_NOON);
    expect(row).toMatchObject({
      state: 'on',
      inside_hours: 1,
      started_by: 'nick',
      day: '2026-11-03',
    });
    const evening = await startShift(
      db,
      team.id,
      ryder,
      'nick',
      PACIFIC,
      at('2026-11-04T04:00:00Z'),
    );
    expect(evening.inside_hours).toBe(0);
    expect(await listAuditByAction(db, team.id, 'shift.started', 5)).toHaveLength(2);
  });

  it('a stop with a live lease is ending, and settleEnding turns it off', async () => {
    const { db, team, ryder } = await seed();
    await startShift(db, team.id, ryder, 'nick', PACIFIC, TUE_NOON);
    const ending = await stopShift(db, team.id, ryder, 'stopped', PACIFIC, TUE_NOON + 1, {
      leaseLive: true,
      actor: 'nick',
    });
    expect(ending).toMatchObject({ state: 'ending', stop_reason: 'stopped' });
    // A second stop finds no shift on.
    expect(
      await stopShift(db, team.id, ryder, 'budget', PACIFIC, TUE_NOON + 2, { leaseLive: false }),
    ).toBeNull();
    await settleEnding(db, team.id, ryder.id, '2026-11-03');
    expect((await getShift(db, team.id, ryder.id, '2026-11-03'))?.state).toBe('off');
  });

  it('hours_end fires on the 17:59 → 18:01 Pacific crossing, never for a Start at 20:00', () => {
    const inside = { inside_hours: 1 };
    expect(shiftStopDue(inside, PACIFIC, 0, 10, at('2026-11-04T01:59:00Z'))).toBeNull();
    expect(shiftStopDue(inside, PACIFIC, 0, 10, at('2026-11-04T02:01:00Z'))).toBe('hours_end');
    expect(
      shiftStopDue({ inside_hours: 0 }, PACIFIC, 0, 10, at('2026-11-04T04:00:00Z')),
    ).toBeNull();
  });

  it('budget fires at $10.00 spent and not at $9.99', () => {
    expect(shiftStopDue({ inside_hours: 1 }, PACIFIC, 10, 10, TUE_NOON)).toBe('budget');
    expect(shiftStopDue({ inside_hours: 1 }, PACIFIC, 9.99, 10, TUE_NOON)).toBeNull();
  });

  it('the spend is live: a cost reported after the lease settled counts on the next read', async () => {
    const { db, team, ryder } = await seed();
    const dayStart = shiftDayStart(PACIFIC, TUE_NOON);
    await leased(db, team.id, 'ryder', 'L1', TUE_NOON - 60_000);
    await cost(db, team.id, 'ryder', 'L1', 1.25, TUE_NOON - 30_000);
    expect(await shiftSpentUsd(db, team.id, 'ryder', dayStart, TUE_NOON)).toBe(1.25);
    await leased(db, team.id, 'ryder', 'L2', TUE_NOON - 20_000);
    // L2 has no cost yet: it counts at the 7-day median (only L1's $1.25 so far).
    expect(await shiftSpentUsd(db, team.id, 'ryder', dayStart, TUE_NOON)).toBe(2.5);
    await cost(db, team.id, 'ryder', 'L2', 3, TUE_NOON - 10_000);
    expect(await shiftSpentUsd(db, team.id, 'ryder', dayStart, TUE_NOON)).toBe(4.25);
    // A wake from yesterday does not count today.
    await leased(db, team.id, 'ryder', 'L0', dayStart - 1);
    expect(await shiftSpentUsd(db, team.id, 'ryder', dayStart, TUE_NOON)).toBe(4.25);
  });

  it('an unpriced wake with no history counts $0.50', async () => {
    const { db, team } = await seed();
    await leased(db, team.id, 'ryder', 'L1', TUE_NOON - 60_000);
    expect(
      await shiftSpentUsd(db, team.id, 'ryder', shiftDayStart(PACIFIC, TUE_NOON), TUE_NOON),
    ).toBe(UNPRICED_WAKE_FALLBACK_USD);
  });

  it('23:50 and 00:10 Pacific are different shift days though the same UTC day', () => {
    expect(shiftDay(PACIFIC, at('2026-11-04T07:50:00Z'))).toBe('2026-11-03');
    expect(shiftDay(PACIFIC, at('2026-11-04T08:10:00Z'))).toBe('2026-11-04');
    expect(shiftDay(null, at('2026-11-04T08:10:00Z'))).toBe('2026-11-04');
  });

  it("a member's own working hours win over the team's", () => {
    const own = { ...PACIFIC, timezone: 'Europe/London' };
    const member = { working_hours: JSON.stringify(own) } as Pick<MemberRow, 'working_hours'>;
    expect(shiftHours(member, PACIFIC)?.timezone).toBe('Europe/London');
    expect(shiftHours({ working_hours: null }, PACIFIC)?.timezone).toBe('America/Los_Angeles');
  });

  it('the shift state: until for a Start inside hours, budget left, null for a human', async () => {
    const { db, team, ryder } = await seed();
    expect(await shiftStateOf(db, team.id, ryder, PACIFIC, 10, TUE_NOON)).toBeNull();
    await startShift(db, team.id, ryder, 'nick', PACIFIC, TUE_NOON);
    await leased(db, team.id, 'ryder', 'L1', TUE_NOON + 1);
    await cost(db, team.id, 'ryder', 'L1', 5.9, TUE_NOON + 2);
    expect(await shiftStateOf(db, team.id, ryder, PACIFIC, 10, TUE_NOON + 3)).toEqual({
      state: 'on',
      since: TUE_NOON,
      until: at('2026-11-04T02:00:00Z'),
      budget_left_usd: 4.1,
      stop_reason: null,
    });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    expect(await shiftStateOf(db, team.id, nick, PACIFIC, 10, TUE_NOON)).toBeNull();
  });
});
