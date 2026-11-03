import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, listAuditByAction } from '../store/audit.js';
import { openLane, updateLane } from '../store/lanes.js';
import { addMember } from '../store/members.js';
import { claimWakeLeases, enrollResidency } from '../store/residency.js';
import type { TeamRow } from '../store/rows.js';
import { getShift, shiftDay, startShift } from '../store/shift.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';
import { rosterShifts, SHIFT_NO_WORK_GRACE_MS, shiftStopLine, sweepShifts } from './shiftWatch.js';

let openStore: () => Promise<Driver>;

function stubCtx(db: Driver): Ctx {
  return {
    db,
    rosterRoots: [],
    config: { presenceTimeoutMs: 60_000 } as Ctx['config'],
    hub: {
      deliver: () => false,
      deliverToAdmins: () => 0,
      broadcastFirehose: () => 0,
    } as unknown as Ctx['hub'],
  };
}

const PACIFIC = JSON.stringify({
  timezone: 'America/Los_Angeles',
  days: ['mon', 'tue', 'wed', 'thu', 'fri'],
  start: '09:00',
  end: '18:00',
});
const at = (iso: string) => Date.parse(iso);

withDrivers('the shift watch (ADR 792)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed(opts: { hours?: string } = {}) {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    if (opts.hours)
      await db.run('UPDATE teams SET working_hours = ? WHERE id = ?', [opts.hours, team.id]);
    const teamRow = { ...team, working_hours: opts.hours ?? null } as TeamRow;
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ryder = (await addMember(db, team, { name: 'ryder', kind: 'agent', role: '' })).row;
    await enrollResidency(db, team.id, {
      member_id: ryder.id,
      harness: 'claude-code',
      host: 'joiner',
      grant_id: 'g1',
      authorized_by: 'nick',
    });
    return { db, team: teamRow, nick, ryder, ctx: stubCtx(db) };
  }

  const quick = (id: string, action: string, ts: number) =>
    makeEnvelope({
      id,
      team: 'revive',
      from: 'nick',
      to: { kind: 'member', name: 'ryder' },
      act: 'steer',
      body: action,
      meta: { quick_action: action },
      ts,
    });

  async function boardLines(db: Driver, teamId: string): Promise<string[]> {
    return (
      await db.all<{ body: string }>(
        "SELECT body FROM messages WHERE team_id = ? AND act = 'status_update' ORDER BY ts, id",
        [teamId],
      )
    ).map((r) => r.body);
  }

  it('the stop line names the reason and what is left', () => {
    expect(
      shiftStopLine({
        seat: 'ryder',
        reason: 'hours_end',
        claimed: 2,
        blocked: 0,
        budgetUsd: 10,
        hoursEnd: '18:00',
      }),
    ).toBe('ryder is off shift: hours ended at 18:00; 2 lanes still claimed.');
    expect(
      shiftStopLine({ seat: 'ryder', reason: 'no_work', claimed: 0, blocked: 0, budgetUsd: 10 }),
    ).toBe('ryder is off shift: no work left; nothing claimed.');
    expect(
      shiftStopLine({ seat: 'ryder', reason: 'budget', claimed: 1, blocked: 0, budgetUsd: 10 }),
    ).toBe("ryder is off shift: today's $10.00 budget is spent; 1 lane still claimed.");
    expect(
      shiftStopLine({ seat: 'ryder', reason: 'no_work', claimed: 0, blocked: 2, budgetUsd: 10 }),
    ).toBe('ryder is off shift: no work left; 2 lanes waiting on someone else.');
  });

  it("the roster reads each agent seat's shift today, and no one else's", async () => {
    const { db, team, nick, ryder, ctx } = await seed();
    const now = Date.now();
    expect((await rosterShifts(ctx, team.id, now)).size).toBe(0);
    await startShift(db, team.id, ryder, 'nick', null, now);
    await startShift(db, team.id, nick, 'nick', null, now);
    const shifts = await rosterShifts(ctx, team.id, now + 1);
    expect([...shifts.keys()]).toEqual([ryder.id]);
    expect(shifts.get(ryder.id)).toMatchObject({ state: 'on', budget_left_usd: 10, until: null });
  });

  describe('Start and Stop', () => {
    it("a person's Start puts the seat on shift; Stop takes it off and the board says so", async () => {
      const { db, team, nick, ryder, ctx } = await seed();
      const now = Date.now();
      await routeEnvelope(ctx, team, nick, quick('s1', 'start', now));
      expect(await getShift(db, team.id, ryder.id, shiftDay(null, now))).toMatchObject({
        state: 'on',
        started_by: 'nick',
      });
      await routeEnvelope(ctx, team, nick, quick('s2', 'stop', now + 1));
      expect(await getShift(db, team.id, ryder.id, shiftDay(null, now))).toMatchObject({
        state: 'off',
        stop_reason: 'stopped',
      });
      expect(await boardLines(db, team.id)).toEqual([
        'ryder is off shift: stopped by nick; nothing claimed.',
      ]);
    });

    it('a Stop while a wake runs leaves it ending; the watch settles it once the lease ends', async () => {
      const { db, team, nick, ryder, ctx } = await seed();
      await openLane(db, team.id, team.slug, 'ryder', { title: 'Fix it', claim: true });
      const now = Date.now();
      await routeEnvelope(ctx, team, nick, quick('s1', 'start', now));
      // The Start itself and the claimed lane are due; one is leased and is live now.
      expect(await claimWakeLeases(db, team.id, team.slug, 'joiner', 45_000)).toHaveLength(1);
      await routeEnvelope(ctx, team, nick, quick('s2', 'stop', now + 1));
      const day = shiftDay(null, now);
      expect((await getShift(db, team.id, ryder.id, day))?.state).toBe('ending');
      await db.run("UPDATE wake_leases SET status = 'reported'");
      await sweepShifts(ctx, now + 2);
      expect((await getShift(db, team.id, ryder.id, day))?.state).toBe('off');
    });
  });

  describe('the sweep', () => {
    it('hours end stops a shift started inside them, with its line', async () => {
      const { db, team, ryder, ctx } = await seed({ hours: PACIFIC });
      await openLane(db, team.id, team.slug, 'ryder', { title: 'Fix it', claim: true });
      const noon = at('2026-11-03T20:00:00Z');
      await startShift(db, team.id, ryder, 'nick', JSON.parse(PACIFIC), noon);
      expect(await sweepShifts(ctx, at('2026-11-04T01:59:00Z'))).toBe(0);
      expect(await sweepShifts(ctx, at('2026-11-04T02:01:00Z'))).toBe(1);
      expect(await boardLines(db, team.id)).toEqual([
        'ryder is off shift: hours ended at 18:00; 1 lane still claimed.',
      ]);
      const stopped = await listAuditByAction(db, team.id, 'shift.stopped', 5);
      expect(JSON.parse(String(stopped[0]!.detail))).toMatchObject({
        reason: 'hours_end',
        lanes_claimed: 1,
      });
    });

    it('the budget stops a shift', async () => {
      const { db, team, ryder, ctx } = await seed();
      await openLane(db, team.id, team.slug, 'ryder', { title: 'Fix it', claim: true });
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      for (const [action, detail] of [
        ['residency.wake_leased', { lease_id: 'L1' }],
        ['residency.wake_cost', { lease_id: 'L1', cost_usd: 10.5 }],
      ] as const)
        await appendAudit(db, team.id, {
          actor: null,
          action,
          target: 'ryder',
          result: 'allow',
          detail,
        });
      expect(await sweepShifts(ctx, now + 1)).toBe(1);
      expect((await boardLines(db, team.id))[0]).toContain('budget is spent');
    });

    it('no work stops a shift only after the Start had its chance, and not while a lane is claimed', async () => {
      const { db, team, ryder, ctx } = await seed();
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      expect(await sweepShifts(ctx, now + 60_000)).toBe(0);
      const lane = await openLane(db, team.id, team.slug, 'ryder', {
        title: 'Fix it',
        claim: true,
      });
      expect(await sweepShifts(ctx, now + SHIFT_NO_WORK_GRACE_MS + 1)).toBe(0);
      await updateLane(db, team.id, lane.id, team.slug, { state: 'blocked' });
      expect(await sweepShifts(ctx, now + SHIFT_NO_WORK_GRACE_MS + 2)).toBe(1);
      expect(await boardLines(db, team.id)).toEqual([
        'ryder is off shift: no work left; 1 lane waiting on someone else.',
      ]);
    });

    it('a shift never outlives its day: past midnight it stops and says so', async () => {
      const { db, team, ryder, ctx } = await seed({ hours: PACIFIC });
      await openLane(db, team.id, team.slug, 'ryder', { title: 'Fix it', claim: true });
      const hours = JSON.parse(PACIFIC);
      await startShift(db, team.id, ryder, 'nick', hours, at('2026-11-04T06:00:00Z')); // 22:00 Tue
      expect(await sweepShifts(ctx, at('2026-11-04T08:30:00Z'))).toBe(1); // 00:30 Wed
      expect(await getShift(db, team.id, ryder.id, '2026-11-03')).toMatchObject({
        state: 'off',
        stop_reason: 'hours_end',
      });
      expect(await getShift(db, team.id, ryder.id, '2026-11-04')).toBeNull();
      expect(await boardLines(db, team.id)).toEqual([
        'ryder is off shift: hours ended; 1 lane still claimed.',
      ]);
    });
  });
});
