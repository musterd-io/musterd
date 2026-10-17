import { makeEnvelope } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, listAudit } from './audit.js';
import { settleProvenance } from './dream.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { claimWakeLeases, enrollResidency } from './residency.js';
import { createTeam, setPolicy } from './teams.js';

let openStore: () => Promise<Driver>;

// ADR 494 §1–§3: a dream is a residency wake with its own derivation, leased only for an idle,
// enrolled, switched-on seat outside its working hours, inside tonight's budget, and only when no
// asked-for wake is due.
withDrivers('residency — the dream lease (ADR 494)', (o) => {
  beforeEach(() => {
    openStore = o;
    // The lease's `residency.wake_leased` audit row is stamped with the wall clock, while every
    // claim below passes a simulated `now`. Left real, today's clock lands inside a simulated
    // night, and the next-night claim found "tonight's dream" already spent once 2026-10-03
    // ~05:30Z had passed (lane 01M41BP7JZ). Only `Date` is faked; the drivers' timers stay real.
    vi.useFakeTimers({ toFake: ['Date'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const HOST = 'laptop.local';
  const PRESENCE_TIMEOUT_MS = 45_000;
  const EVERY_DAY = {
    timezone: 'America/Los_Angeles',
    days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const,
    start: '08:00',
    end: '22:30',
  };
  const NIGHT = Date.parse('2026-10-02T10:00:00Z'); // 03:00 PDT Oct 2 — the night keyed 2026-10-01
  const DAY = Date.parse('2026-10-02T18:00:00Z'); // 11:00 PDT

  async function seed(opts: { hours?: boolean; dream?: boolean } = {}) {
    const db = await openStore();
    const team = await createTeam(db, {
      slug: 'revive',
      ...(opts.hours === false
        ? {}
        : { workingHours: { ...EVERY_DAY, days: [...EVERY_DAY.days] } }),
    });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'ada', kind: 'agent' })).row;
    // These tests stamp acts at a fixed fake NIGHT. A seat is owed only what arrived after it existed
    // (ADR 549), so the members must predate them.
    await db.run('UPDATE members SET created_at = 0 WHERE team_id = ?', [team.id]);
    await enrollResidency(db, team.id, {
      member_id: ada.id,
      harness: 'claude-code',
      host: HOST,
      grant_id: 'g1',
      authorized_by: 'nick',
    });
    if (opts.dream !== false) await setPolicy(db, team.id, { residency: { dream_enabled: true } });
    return { db, team, nick, ada };
  }

  const claim = (db: Driver, teamId: string, now: number) => {
    vi.setSystemTime(now);
    return claimWakeLeases(db, teamId, 'revive', HOST, PRESENCE_TIMEOUT_MS, now);
  };

  /** Settle every open lease so the next poll is not blocked by a live one. */
  const settleAll = (db: Driver) => db.run("UPDATE wake_leases SET status = 'reported'");

  it('leases a fresh, act-free dream for an idle seat at night', async () => {
    const { db, team } = await seed();
    const orders = await claim(db, team.id, NIGHT);
    expect(orders).toHaveLength(1);
    const [o] = orders;
    expect(o).toMatchObject({ seat: 'ada', derivation: 'dream', intended_delivery: 'fresh' });
    expect(o!.act_id).toBeUndefined();
    expect(o!.lane_id).toBeUndefined();
    expect(o!.composed_line).toContain('dream');
    const leased = (await listAudit(db, team.id)).filter(
      (r) => r.action === 'residency.wake_leased',
    );
    expect(leased).toHaveLength(1);
    expect(JSON.parse(String(leased[0]!.detail))).toMatchObject({ derivation: 'dream' });
  });

  it('never dreams during working hours, when switched off, or with no schedule', async () => {
    const day = await seed();
    expect(await claim(day.db, day.team.id, DAY)).toEqual([]);
    const off = await seed({ dream: false });
    expect(await claim(off.db, off.team.id, NIGHT)).toEqual([]);
    const unscheduled = await seed({ hours: false });
    expect(await claim(unscheduled.db, unscheduled.team.id, NIGHT)).toEqual([]);
  });

  it('dreams once a night by default, and again the next night', async () => {
    const { db, team } = await seed();
    expect(await claim(db, team.id, NIGHT)).toHaveLength(1);
    await settleAll(db);
    // Past the default cooldown (30m) and hourly cap window, still the same night.
    expect(await claim(db, team.id, NIGHT + 2 * 3_600_000)).toEqual([]);
    // 03:00 PDT the following night.
    expect(await claim(db, team.id, NIGHT + 24 * 3_600_000)).toHaveLength(1);
  });

  it('does not count a deferred dream against the night', async () => {
    const { db, team } = await seed();
    const [o] = await claim(db, team.id, NIGHT);
    await settleAll(db);
    await appendAudit(db, team.id, {
      actor: null,
      action: 'residency.wake_deferred',
      target: 'ada',
      result: 'allow',
      detail: { lease_id: o!.lease_id },
    });
    // appendAudit stamps the wall clock; put the deferral inside the simulated night.
    await db.run(
      'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
      [NIGHT + 60_000],
    );
    // The deferral snooze lifts after its window; the night's single dream is still unspent.
    const later = await claim(db, team.id, NIGHT + 2 * 3_600_000);
    expect(later.map((x) => x.derivation)).toEqual(['dream']);
  });

  it('yields to asked-for work: a due inbox wake is leased instead of a dream', async () => {
    const { db, team, nick, ada } = await seed();
    await insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: '01HDREAMYIELD0000000000001',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'look at this',
        ts: NIGHT - 60_000,
      }),
      { now: NIGHT - 60_000 },
    );
    const orders = await claim(db, team.id, NIGHT);
    expect(orders).toHaveLength(1);
    expect(orders[0]!.derivation).not.toBe('dream');
  });

  // ADR 494 §4: `dream` is server-derived from the lease. A session holding a dream lease is a
  // dream whatever it attests (it cannot shed it), and no session can claim `dream` without one.
  it('derives dream provenance from the lease, never from the client alone', async () => {
    const { db, team, nick, ada } = await seed();
    const [dream] = await claim(db, team.id, NIGHT);
    expect(await settleProvenance(db, ada, 'wake', dream!.lease_id)).toBe('dream');
    expect(await settleProvenance(db, ada, undefined, dream!.lease_id)).toBe('dream');
    expect(await settleProvenance(db, ada, 'dream', undefined)).toBeUndefined();
    expect(await settleProvenance(db, ada, 'session', undefined)).toBe('session');
    // Another seat cannot borrow ada's dream lease.
    expect(await settleProvenance(db, nick, 'dream', dream!.lease_id)).toBeUndefined();
    // An ordinary wake lease claiming `dream` is a wake.
    await settleAll(db);
    await insertMessage(
      db,
      team.id,
      nick.id,
      ada.id,
      makeEnvelope({
        id: '01HDREAMPROV00000000000001',
        team: 'revive',
        from: 'nick',
        to: { kind: 'member', name: 'ada' },
        act: 'steer',
        body: 'x',
        ts: NIGHT + 3_600_000,
      }),
      { now: NIGHT + 3_600_000 },
    );
    const [wake] = await claim(db, team.id, NIGHT + 3_700_000);
    expect(wake!.derivation).not.toBe('dream');
    expect(await settleProvenance(db, ada, 'dream', wake!.lease_id)).toBe('wake');
  });

  // ADR 494 §4 "no chain": an act a dream sent is never a wake reason for another seat.
  it('never wakes a seat for an act a dream sent', async () => {
    const { db, team, nick, ada } = await seed({ dream: false });
    const bob = (await addMember(db, team, { name: 'bob', kind: 'agent' })).row;
    await db.run('UPDATE members SET created_at = 0 WHERE id = ?', [bob.id]);
    for (const [id, act] of [
      ['01HDREAMCHAIN0000000000001', 'steer'],
      ['01HDREAMCHAIN0000000000002', 'request_help'],
    ] as const) {
      await insertMessage(
        db,
        team.id,
        bob.id,
        ada.id,
        makeEnvelope({
          id,
          team: 'revive',
          from: 'bob',
          to: { kind: 'member', name: 'ada' },
          act,
          body: 'x',
          ts: NIGHT - 60_000,
        }),
        { now: NIGHT - 60_000 },
      );
    }
    await db.run("UPDATE messages SET from_provenance = 'dream' WHERE from_member = ?", [bob.id]);
    expect(await claim(db, team.id, NIGHT)).toEqual([]);
    expect(nick.name).toBe('nick');
  });

  it('holds a dream at the cap and does not spend the night (ADR 611)', async () => {
    const { db, team } = await seed();
    vi.setSystemTime(NIGHT);
    const held = await claimWakeLeases(
      db,
      team.id,
      'revive',
      HOST,
      PRESENCE_TIMEOUT_MS,
      NIGHT,
      { creatorId: null, teamWide: true },
      { capUsd: 1, totalUsd: 1, windowDays: 7 },
    );
    expect(held).toEqual([]);
    const gates = (await listAudit(db, team.id)).filter((r) => r.action === 'action.gate');
    expect(gates).toHaveLength(1);
    expect(JSON.parse(String(gates[0]!.detail))).toMatchObject({
      cause: 'spend_cap',
      outcome: 'denied_held',
    });
    expect(await claim(db, team.id, NIGHT)).toHaveLength(1);
  });

  it('holds a dream at an unpriced cap of 0 and does not spend the night (ADR 641)', async () => {
    const { db, team } = await seed();
    vi.setSystemTime(NIGHT);
    const held = await claimWakeLeases(
      db,
      team.id,
      'revive',
      HOST,
      PRESENCE_TIMEOUT_MS,
      NIGHT,
      { creatorId: null, teamWide: true },
      null,
      { cap: 0, count: 0, windowDays: 7 },
    );
    expect(held).toEqual([]);
    const gates = (await listAudit(db, team.id)).filter((r) => r.action === 'action.gate');
    expect(gates).toHaveLength(1);
    expect(JSON.parse(String(gates[0]!.detail))).toMatchObject({
      cause: 'unpriced_wake_cap',
      outcome: 'denied_held',
      cap: 0,
      count: 0,
    });
    expect(await claim(db, team.id, NIGHT)).toHaveLength(1);
  });
});
