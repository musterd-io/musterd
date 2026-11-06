import { makeEnvelope } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit } from '../store/audit.js';
import { addMember } from '../store/members.js';
import { insertMessage } from '../store/messages.js';
import { enrollResidency, recordHostSeen } from '../store/residency.js';
import type { MemberRow } from '../store/rows.js';
import { createTeam } from '../store/teams.js';
import { FlyApiError, type FlyMachines } from './flyMachines.js';
import { newFlyWatchState, sweepFlyMachines, type FlyWatchDeps } from './flyWatch.js';

/**
 * ADR 816: the fly watch starts a stopped mapped machine when a wake is due and stops it when
 * proven idle. The Fly side is a fake — every case reads its verdict off the fake's call counts
 * and the `fly.machine_*` audit rows, never off a real machine.
 */

let openStore: () => Promise<Driver>;

const MAPPED = { revive: { 'cloud-delta-2': { app: 'musterd-agent-delta-2', machine: 'm1' } } };

function stubCtx(db: Driver, over: Record<string, unknown> = {}): Ctx {
  return {
    db,
    rosterRoots: [],
    config: {
      presenceTimeoutMs: 60_000,
      flyApiToken: 'tok',
      flyMachines: MAPPED,
      flyIdleStopMs: 15 * 60_000,
      flyNoPollStopMs: 10 * 60_000,
      flyWatchMs: 60_000,
      ...over,
    } as Ctx['config'],
    hub: { deliver: () => false, broadcastFirehose: () => 0 } as unknown as Ctx['hub'],
  };
}

class FakeFly implements FlyMachines {
  state: string;
  starts = 0;
  stops = 0;
  failStart = false;
  constructor(state = 'stopped') {
    this.state = state;
  }
  async machineState() {
    return this.state;
  }
  async startMachine() {
    this.starts += 1;
    if (this.failStart) throw new FlyApiError(503, 'unavailable');
    this.state = 'started';
  }
  async stopMachine() {
    this.stops += 1;
    this.state = 'stopped';
  }
}

const deps = (fly: FakeFly): FlyWatchDeps => ({ fly, state: newFlyWatchState() });

withDrivers('flyWatch (ADR 816)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed() {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const delta = (await addMember(db, team, { name: 'delta', kind: 'agent', role: '' })).row;
    await enrollResidency(db, team.id, {
      member_id: delta.id,
      harness: 'claude-code',
      host: 'cloud-delta-2',
      grant_id: 'g1',
      authorized_by: 'nick',
    });
    return { db, team, nick, delta, ctx: stubCtx(db) };
  }

  async function steer(
    db: Driver,
    teamId: string,
    from: MemberRow,
    to: MemberRow,
    id: string,
    at: number,
  ) {
    await insertMessage(
      db,
      teamId,
      from.id,
      to.id,
      makeEnvelope({
        id,
        team: 'revive',
        from: from.name,
        to: { kind: 'member', name: to.name },
        act: 'steer',
        body: 'get up',
        ts: at,
      }),
      { now: at },
    );
  }

  async function flyAudits(db: Driver, teamId: string) {
    return db.all<{ action: string; result: string; detail: string | null }>(
      `SELECT action, result, detail FROM audit WHERE team_id = ? AND action LIKE 'fly.%' ORDER BY ts, id`,
      [teamId],
    );
  }

  it('starts a stopped mapped machine when an unread directed act waits, and audits it', async () => {
    const { db, team, nick, delta, ctx } = await seed();
    const t = Date.now();
    await steer(db, team.id, nick, delta, 'a1', t);
    const fly = new FakeFly('stopped');
    expect(await sweepFlyMachines(ctx, t, deps(fly))).toBe(1);
    expect(fly.starts).toBe(1);
    const rows = await flyAudits(db, team.id);
    expect(rows.map((r) => [r.action, r.result])).toEqual([['fly.machine_start', 'allow']]);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ host: 'cloud-delta-2', seat: 'delta' });
  });

  it('does not start when nothing waits for the seat', async () => {
    const { ctx } = await seed();
    const fly = new FakeFly('stopped');
    expect(await sweepFlyMachines(ctx, Date.now(), deps(fly))).toBe(0);
    expect(fly.starts).toBe(0);
  });

  it('is inert without a token — the feature is off by absence', async () => {
    const { db, team, nick, delta } = await seed();
    await steer(db, team.id, nick, delta, 'a1', Date.now());
    const ctx = stubCtx(db, { flyApiToken: null });
    expect(await sweepFlyMachines(ctx, Date.now())).toBe(0);
  });

  it('audits a failed start as a denial with the Fly status, and backs off instead of hammering', async () => {
    const { db, team, nick, delta, ctx } = await seed();
    const t = Date.now();
    await steer(db, team.id, nick, delta, 'a1', t);
    const fly = new FakeFly('stopped');
    fly.failStart = true;
    const d = deps(fly);
    expect(await sweepFlyMachines(ctx, t, d)).toBe(0);
    expect(await sweepFlyMachines(ctx, t + 5_000, d)).toBe(0);
    expect(fly.starts).toBe(1); // one attempt; the second tick is inside the backoff window
    const rows = await flyAudits(db, team.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.result).toBe('deny');
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ status: 503 });
  });

  it('stops a started machine once idle past the window, with reason idle', async () => {
    const { db, team, delta, ctx } = await seed();
    const t = Date.now();
    await recordHostSeen(db, team.id, 'cloud-delta-2', t, null);
    const fly = new FakeFly('started');
    const d = deps(fly);
    expect(await sweepFlyMachines(ctx, t, d)).toBe(0); // first sighting starts the idle clock
    expect(await sweepFlyMachines(ctx, t + 16 * 60_000, d)).toBe(1);
    expect(fly.stops).toBe(1);
    const rows = await flyAudits(db, team.id);
    expect(rows.map((r) => r.action)).toEqual(['fly.machine_stop']);
    expect(JSON.parse(rows[0]!.detail!)).toMatchObject({ reason: 'idle' });
    void delta;
  });

  it('a directed act older than the last wake does not hold the stop (the delta-2 shape)', async () => {
    // Measured live 2026-11-06: a hub-mode seat reads its inbox on its joiner daemon, so the
    // hub holds no cursor row for it — a cursor-only unread count held delta-2's machine up
    // forever on five already-answered acts. The record is in this test's name on purpose.
    const { db, team, nick, delta, ctx } = await seed();
    const t = Date.now();
    await steer(db, team.id, nick, delta, 'a1', t);
    await recordHostSeen(db, team.id, 'cloud-delta-2', t, null);
    await appendAudit(db, team.id, {
      actor: null,
      action: 'residency.woke',
      target: 'delta',
      result: 'allow',
      detail: {},
    });
    const fly = new FakeFly('started');
    const d = deps(fly);
    await sweepFlyMachines(ctx, t, d);
    expect(await sweepFlyMachines(ctx, t + 16 * 60_000, d)).toBe(1);
    expect(fly.stops).toBe(1);
    // And it must not restart for that same act: it was in front of the last wake.
    expect(await sweepFlyMachines(ctx, t + 17 * 60_000, d)).toBe(0);
    expect(fly.starts).toBe(0);
  });

  it('a directed act newer than the last wake holds the stop', async () => {
    const { db, team, nick, delta, ctx } = await seed();
    const t = Date.now();
    await recordHostSeen(db, team.id, 'cloud-delta-2', t, null);
    await appendAudit(db, team.id, {
      actor: null,
      action: 'residency.woke',
      target: 'delta',
      result: 'allow',
      detail: {},
    });
    await steer(db, team.id, nick, delta, 'a-late', t + 60_000);
    const fly = new FakeFly('started');
    const d = deps(fly);
    await sweepFlyMachines(ctx, t, d);
    expect(await sweepFlyMachines(ctx, t + 16 * 60_000, d)).toBe(0);
    expect(fly.stops).toBe(0);
  });

  it('recent wake activity holds the stop', async () => {
    const { db, team, ctx } = await seed();
    const t = Date.now();
    await recordHostSeen(db, team.id, 'cloud-delta-2', t, null);
    const fly = new FakeFly('started');
    const d = deps(fly);
    await sweepFlyMachines(ctx, t, d);
    await appendAudit(db, team.id, {
      actor: null,
      action: 'residency.woke',
      target: 'delta',
      result: 'allow',
      detail: {},
    });
    // The audit row stamps its own write time (~t); 10 min later is inside the idle window.
    expect(await sweepFlyMachines(ctx, t + 10 * 60_000, d)).toBe(0);
    expect(fly.stops).toBe(0);
  });

  it('a live wake lease holds the stop', async () => {
    const { db, team, delta, ctx } = await seed();
    const t = Date.now();
    await recordHostSeen(db, team.id, 'cloud-delta-2', t, null);
    await db.run(
      `INSERT INTO wake_leases (id, team_id, member_id, act_id, host, lane, status, created_at, expires_at)
       VALUES ('l1', ?, ?, 'a1', 'cloud-delta-2', 'immediate', 'leased', ?, ?)`,
      [team.id, delta.id, t, t + 60 * 60_000],
    );
    const fly = new FakeFly('started');
    const d = deps(fly);
    await sweepFlyMachines(ctx, t, d);
    expect(await sweepFlyMachines(ctx, t + 30 * 60_000, d)).toBe(0);
    expect(fly.stops).toBe(0);
  });

  it('an on-shift seat holds the stop', async () => {
    const { db, team, delta, ctx } = await seed();
    const t = Date.now();
    await recordHostSeen(db, team.id, 'cloud-delta-2', t, null);
    await db.run(
      `INSERT INTO shifts (team_id, member_id, day, state, started_at, started_by, inside_hours, stopped_at, stop_reason)
       VALUES (?, ?, '2026-11-06', 'on', ?, 'nick', 1, NULL, NULL)`,
      [team.id, delta.id, t],
    );
    const fly = new FakeFly('started');
    const d = deps(fly);
    await sweepFlyMachines(ctx, t, d);
    expect(await sweepFlyMachines(ctx, t + 30 * 60_000, d)).toBe(0);
    expect(fly.stops).toBe(0);
  });

  it('stops a hub-started machine that never polls, with reason no_poll', async () => {
    const { db, team, nick, delta, ctx } = await seed();
    const t = Date.now();
    await steer(db, team.id, nick, delta, 'a1', t);
    const fly = new FakeFly('stopped');
    const d = deps(fly);
    expect(await sweepFlyMachines(ctx, t, d)).toBe(1); // starts; no poll ever arrives
    expect(await sweepFlyMachines(ctx, t + 11 * 60_000, d)).toBe(1);
    expect(fly.stops).toBe(1);
    const rows = await flyAudits(db, team.id);
    expect(rows.map((r) => r.action)).toEqual(['fly.machine_start', 'fly.machine_stop']);
    expect(JSON.parse(rows[1]!.detail!)).toMatchObject({ reason: 'no_poll' });
  });
});
