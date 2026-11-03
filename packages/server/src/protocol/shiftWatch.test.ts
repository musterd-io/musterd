import { GENERALIST_CAPABILITIES, makeEnvelope } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, listAuditByAction } from '../store/audit.js';
import { getLane, openLane, updateLane } from '../store/lanes.js';
import { addMember, getMemberByName, setMemberGovernance } from '../store/members.js';
import { claimWakeLeases, enrollResidency } from '../store/residency.js';
import type { MemberRow, TeamRow } from '../store/rows.js';
import { getShift, shiftDay, startShift } from '../store/shift.js';
import { createTeam } from '../store/teams.js';
import { routeEnvelope } from './route.js';
import {
  autoStartShifts,
  rosterShifts,
  settleBudgetAsks,
  SHIFT_NO_WORK_GRACE_MS,
  shiftStopLine,
  sweepShifts,
} from './shiftWatch.js';

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

  describe('out of work (ADR 793)', () => {
    async function recommended(db: Driver, teamId: string) {
      const rows = await listAuditByAction(db, teamId, 'shift.recommended', 5);
      return rows.map((r) => JSON.parse(String(r.detail)) as { question: string; lanes: string[] });
    }

    /** nick answers on /live: through the route, which claims the question and stamps its proof. */
    async function answer(
      ctx: Ctx,
      team: TeamRow,
      nick: MemberRow,
      question: string,
      choice: number,
    ) {
      await routeEnvelope(
        ctx,
        team,
        nick,
        makeEnvelope({
          id: `a-${question}`,
          team: team.slug,
          from: 'nick',
          to: { kind: 'member', name: 'ryder' },
          act: 'accept',
          body: '',
          thread: question,
          meta: { in_reply_to: question, answer: { choice } },
        }),
      );
    }

    it('at ask, a seat with nothing claimed asks once which open lane to take, and waits', async () => {
      const { db, team, ryder, ctx } = await seed();
      for (const t of ['One', 'Two', 'Three', 'Four'])
        await openLane(db, team.id, team.slug, 'nick', { title: t });
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      const after = now + SHIFT_NO_WORK_GRACE_MS + 1;
      expect(await sweepShifts(ctx, after)).toBe(0);
      const [rec] = await recommended(db, team.id);
      expect(rec!.lanes).toHaveLength(3);
      const ask = await db.get<{ meta: string; to_kind: string }>(
        'SELECT meta, to_kind FROM messages WHERE id = ?',
        [rec!.question],
      );
      const q = (JSON.parse(ask!.meta) as { question: { options: Array<{ label: string }> } })
        .question;
      expect(ask!.to_kind).toBe('team');
      expect(q.options.map((o) => o.label)).toEqual([
        `One (${rec!.lanes[0]})`,
        `Two (${rec!.lanes[1]})`,
        `Three (${rec!.lanes[2]})`,
        'None, end my shift',
      ]);
      // The question is open: no second ask, no stop.
      expect(await sweepShifts(ctx, after + 60_000)).toBe(0);
      expect(await recommended(db, team.id)).toHaveLength(1);
      expect((await getShift(db, team.id, ryder.id, shiftDay(null, now)))?.state).toBe('on');
    });

    it('an answer of none stops the shift; a picked lane gets its wake first', async () => {
      const { db, team, nick, ryder, ctx } = await seed();
      await openLane(db, team.id, team.slug, 'nick', { title: 'One' });
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      const t1 = now + SHIFT_NO_WORK_GRACE_MS + 1;
      await sweepShifts(ctx, t1);
      const [rec] = await recommended(db, team.id);
      await answer(ctx, team, nick, rec!.question, 0); // picked "One"
      const answeredAt = (await db.get<{ ts: number }>('SELECT ts FROM messages WHERE id = ?', [
        `a-${rec!.question}`,
      ]))!.ts;
      expect(await sweepShifts(ctx, answeredAt + 60_000)).toBe(0);
      // It never claimed it: past the grace, the shift ends for want of work.
      expect(await sweepShifts(ctx, answeredAt + SHIFT_NO_WORK_GRACE_MS + 1)).toBe(1);
      expect(await boardLines(db, team.id)).toEqual([
        'ryder is off shift: no work left; nothing claimed.',
      ]);

      // A fresh Start, a fresh recommendation, answered "none": it stops on the next sweep.
      const t2 = answeredAt + SHIFT_NO_WORK_GRACE_MS + 10;
      await startShift(db, team.id, ryder, 'nick', null, t2);
      await sweepShifts(ctx, t2 + SHIFT_NO_WORK_GRACE_MS + 1);
      const second = (await recommended(db, team.id))[0]!;
      await answer(ctx, team, nick, second.question, 1); // "None"
      expect(await sweepShifts(ctx, t2 + SHIFT_NO_WORK_GRACE_MS + 2)).toBe(1);
    });

    it('nothing on the board to offer: it stops at once', async () => {
      const { db, team, ryder, ctx } = await seed();
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      expect(await sweepShifts(ctx, now + SHIFT_NO_WORK_GRACE_MS + 1)).toBe(1);
      expect(await recommended(db, team.id)).toHaveLength(0);
    });

    it('at claim it takes a lane on a named goal, never a risky one; at free any safe lane', async () => {
      const { db, team, ryder, ctx } = await seed();
      await db.run('UPDATE residency SET policy = ? WHERE member_id = ?', [
        JSON.stringify({ autonomy: 'claim', autonomy_goals: ['g-ok'] }),
        ryder.id,
      ]);
      const risky = await openLane(db, team.id, team.slug, 'nick', {
        title: 'Risky',
        goal_id: 'g-ok',
        risk: ['user-facing'],
      });
      const other = await openLane(db, team.id, team.slug, 'nick', {
        title: 'Other goal',
        goal_id: 'g-no',
      });
      const ok = await openLane(db, team.id, team.slug, 'nick', {
        title: 'On goal',
        goal_id: 'g-ok',
      });
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      await sweepShifts(ctx, now + SHIFT_NO_WORK_GRACE_MS + 1);
      expect((await getLane(db, team.id, ok.id, team.slug))?.owner_seat).toBe('ryder');
      expect((await getLane(db, team.id, risky.id, team.slug))?.owner_seat).toBeNull();
      expect((await getLane(db, team.id, other.id, team.slug))?.owner_seat).toBeNull();
      expect(await listAuditByAction(db, team.id, 'shift.claimed', 5)).toHaveLength(1);

      await updateLane(db, team.id, ok.id, team.slug, { state: 'done' });
      await db.run('UPDATE residency SET policy = ? WHERE member_id = ?', [
        JSON.stringify({ autonomy: 'free' }),
        ryder.id,
      ]);
      await sweepShifts(ctx, now + SHIFT_NO_WORK_GRACE_MS + 2);
      expect((await getLane(db, team.id, other.id, team.slug))?.owner_seat).toBe('ryder');
      expect((await getLane(db, team.id, risky.id, team.slug))?.owner_seat).toBeNull();
    });

    it('shift_start auto starts an enrolled seat once a day, inside hours only', async () => {
      const { db, team, ryder, ctx } = await seed({ hours: PACIFIC });
      await db.run('UPDATE residency SET policy = ? WHERE member_id = ?', [
        JSON.stringify({ shift_start: 'auto' }),
        ryder.id,
      ]);
      expect(await autoStartShifts(ctx, at('2026-11-03T15:00:00Z'))).toBe(0); // 07:00 Tue
      expect(await autoStartShifts(ctx, at('2026-11-03T17:05:00Z'))).toBe(1); // 09:05 Tue
      expect(await getShift(db, team.id, ryder.id, '2026-11-03')).toMatchObject({
        state: 'on',
        started_by: 'auto',
        inside_hours: 1,
      });
      expect(await autoStartShifts(ctx, at('2026-11-03T18:00:00Z'))).toBe(0); // already today
      expect(await autoStartShifts(ctx, at('2026-11-08T18:00:00Z'))).toBe(0); // Sunday
    });
  });

  describe('a Start after a budget stop (ADR 795)', () => {
    /** Only an admin or the seat's sponsor may raise its spend. */
    async function asAdmin(db: Driver, team: TeamRow) {
      const nick = (await getMemberByName(db, team.id, 'nick'))!;
      await setMemberGovernance(
        db,
        nick.id,
        null,
        JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      );
      return (await getMemberByName(db, team.id, 'nick'))!;
    }

    async function spendTen(db: Driver, team: TeamRow) {
      for (const [action, detail] of [
        ['residency.wake_leased', { lease_id: 'L1' }],
        ['residency.wake_cost', { lease_id: 'L1', cost_usd: 10 }],
      ] as const)
        await appendAudit(db, team.id, {
          actor: null,
          action,
          target: 'ryder',
          result: 'allow',
          detail,
        });
    }

    async function budgetQuestion(db: Driver, teamId: string) {
      const [row] = await listAuditByAction(db, teamId, 'shift.budget_asked', 5);
      return (JSON.parse(String(row!.detail)) as { question: string }).question;
    }

    it('asks the admin who pressed Start; yes adds a day for today and puts it back on shift', async () => {
      const { db, team, ryder, ctx } = await seed();
      const nick = await asAdmin(db, team);
      await openLane(db, team.id, team.slug, 'ryder', { title: 'Fix it', claim: true });
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      await spendTen(db, team);
      expect(await sweepShifts(ctx, now + 1)).toBe(1); // budget stop
      await routeEnvelope(ctx, team, nick, quick('s1', 'start', now + 2));
      const day = shiftDay(null, now);
      expect((await getShift(db, team.id, ryder.id, day))?.state).toBe('off');
      const q = await budgetQuestion(db, team.id);
      const ask = await db.get<{ to_member: string; body: string }>(
        'SELECT to_member, body FROM messages WHERE id = ?',
        [q],
      );
      expect(ask).toMatchObject({ to_member: nick.id });
      expect(ask!.body).toContain('Add $10.00 for today');
      // A second Start does not ask twice while the first question is open.
      await routeEnvelope(ctx, team, nick, quick('s2', 'start', now + 3));
      expect(await listAuditByAction(db, team.id, 'shift.budget_asked', 5)).toHaveLength(1);

      await routeEnvelope(
        ctx,
        team,
        nick,
        makeEnvelope({
          id: 'a-budget',
          team: team.slug,
          from: 'nick',
          to: { kind: 'member', name: 'ryder' },
          act: 'accept',
          body: '',
          thread: q,
          meta: { in_reply_to: q, answer: { choice: 0 } },
        }),
      );
      expect(await settleBudgetAsks(ctx, Date.now())).toBe(1);
      expect((await getShift(db, team.id, ryder.id, day))?.state).toBe('on');
      const [shift] = [...(await rosterShifts(ctx, team.id, Date.now())).values()];
      expect(shift?.budget_left_usd).toBe(10);
      // Settled once.
      expect(await settleBudgetAsks(ctx, Date.now())).toBe(0);
    });

    it('a person who may not change the seat is not asked', async () => {
      const { db, team, nick, ryder, ctx } = await seed();
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      await spendTen(db, team);
      await sweepShifts(ctx, now + 1);
      await routeEnvelope(ctx, team, nick, quick('s1', 'start', now + 2));
      expect(await listAuditByAction(db, team.id, 'shift.budget_asked', 5)).toHaveLength(0);
      const [denied] = await listAuditByAction(db, team.id, 'shift.budget_declined', 5);
      expect(JSON.parse(String(denied!.detail))).toMatchObject({ reason: 'not_authorized' });
      expect((await getShift(db, team.id, ryder.id, shiftDay(null, now)))?.state).toBe('off');
    });

    it('no leaves it off shift', async () => {
      const { db, team, ryder, ctx } = await seed();
      const nick = await asAdmin(db, team);
      const now = Date.now();
      await startShift(db, team.id, ryder, 'nick', null, now);
      await spendTen(db, team);
      await sweepShifts(ctx, now + 1);
      await routeEnvelope(ctx, team, nick, quick('s1', 'start', now + 2));
      const q = await budgetQuestion(db, team.id);
      await routeEnvelope(
        ctx,
        team,
        nick,
        makeEnvelope({
          id: 'a-no',
          team: team.slug,
          from: 'nick',
          to: { kind: 'member', name: 'ryder' },
          act: 'accept',
          body: '',
          thread: q,
          meta: { in_reply_to: q, answer: { choice: 1 } },
        }),
      );
      expect(await settleBudgetAsks(ctx, Date.now())).toBe(0);
      expect(await listAuditByAction(db, team.id, 'shift.budget_declined', 5)).toHaveLength(1);
      expect((await getShift(db, team.id, ryder.id, shiftDay(null, now)))?.state).toBe('off');
    });
  });
});
