import { makeEnvelope, type Act } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { appendAudit, listAudit } from './audit.js';
import { openLane, updateLane } from './lanes.js';
import { addMember } from './members.js';
import { insertMessage } from './messages.js';
import { claimWakeLeases, enrollResidency } from './residency.js';
import type { MemberRow, TeamRow } from './rows.js';
import { startShift } from './shift.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;
const HOST = 'laptop.local';
const PRESENCE_TIMEOUT_MS = 45_000;

withDrivers('residency — the shift derivation (ADR 792)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  async function seed(policy: Record<string, unknown> = { hourly_cap: 1 }) {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const ada = (await addMember(db, team, { name: 'Ada', kind: 'agent' })).row;
    const bob = (await addMember(db, team, { name: 'bob', kind: 'agent' })).row;
    await enrollResidency(db, team.id, {
      member_id: ada.id,
      harness: 'claude-code',
      host: HOST,
      grant_id: 'g1',
      authorized_by: 'nick',
      policy,
    });
    return { db, team, nick, ada, bob };
  }

  /** One wake ten minutes ago: at a cap of 1 and inside the default cooldown. */
  async function atCap(db: Driver, team: TeamRow) {
    await appendAudit(db, team.id, {
      actor: null,
      action: 'residency.woke',
      target: 'Ada',
      result: 'allow',
      detail: { act: 'past', lease_id: 'x' },
    });
    await db.run(
      'UPDATE audit SET ts = ? WHERE id = (SELECT id FROM audit ORDER BY id DESC LIMIT 1)',
      [Date.now() - 10 * 60_000],
    );
  }

  async function msg(
    db: Driver,
    team: TeamRow,
    from: MemberRow,
    to: MemberRow,
    act: Act,
    id: string,
    meta: Record<string, unknown> | null = null,
  ) {
    await insertMessage(
      db,
      team.id,
      from.id,
      to.id,
      makeEnvelope({
        id,
        team: team.slug,
        from: from.name,
        to: { kind: 'member', name: to.name },
        act,
        body: 'x',
        meta,
        ts: Date.now() - 1_000,
      }),
    );
  }

  const claim = (db: Driver, team: TeamRow) =>
    claimWakeLeases(db, team.id, team.slug, HOST, PRESENCE_TIMEOUT_MS);

  async function leasedRows(db: Driver, teamId: string) {
    return (await listAudit(db, teamId))
      .filter((r) => r.action === 'residency.wake_leased')
      .map((r) => JSON.parse(r.detail as string) as Record<string, unknown>);
  }

  async function claimedLane(db: Driver, team: TeamRow) {
    return openLane(db, team.id, team.slug, 'Ada', { title: 'Fix the flake', claim: true });
  }

  describe('on shift', () => {
    it('a claimed lane wakes the seat past its cap, as a work order with the shift line', async () => {
      const { db, team, ada } = await seed();
      await atCap(db, team);
      const lane = await claimedLane(db, team);
      await startShift(db, team.id, ada, 'nick', null, Date.now());
      const orders = await claim(db, team);
      expect(orders).toHaveLength(1);
      expect(orders[0]).toMatchObject({ seat: 'Ada', derivation: 'work_order', lane_id: lane.id });
      expect(orders[0]!.act_id).toBeUndefined();
      expect(orders[0]!.composed_line).toContain('you are on shift (budget $10.00 left)');
      expect(orders[0]!.composed_line).toContain(`Your lane ${lane.id} is claimed and not done`);
      // ADR 179: no lane title in a spawn prompt.
      expect(orders[0]!.composed_line).not.toContain('Fix the flake');
      expect(await leasedRows(db, team.id)).toEqual([
        expect.objectContaining({ lane_id: lane.id, shift: true }),
      ]);
    });

    it('a lane awaiting acceptance is not work', async () => {
      const { db, team, ada } = await seed();
      const lane = await claimedLane(db, team);
      await updateLane(db, team.id, lane.id, team.slug, { state: 'awaiting_acceptance' });
      await startShift(db, team.id, ada, 'nick', null, Date.now());
      expect(await claim(db, team)).toEqual([]);
    });

    it('a seat waiting on its own open question is not woken for claimed work', async () => {
      const { db, team, nick, ada } = await seed();
      await claimedLane(db, team);
      await startShift(db, team.id, ada, 'nick', null, Date.now());
      await msg(db, team, ada, nick, 'ask', 'q1', {
        species: 'consult',
        question: { text: 'Which?', options: [{ label: 'A' }, { label: 'B' }] },
      });
      expect(await claim(db, team)).toEqual([]);
    });

    it("the day's budget spent: no shift wake", async () => {
      const { db, team, ada } = await seed();
      await claimedLane(db, team);
      await startShift(db, team.id, ada, 'nick', null, Date.now());
      await appendAudit(db, team.id, {
        actor: null,
        action: 'residency.wake_leased',
        target: 'Ada',
        result: 'allow',
        detail: { lease_id: 'L-spent' },
      });
      await appendAudit(db, team.id, {
        actor: null,
        action: 'residency.wake_cost',
        target: 'Ada',
        result: 'allow',
        detail: { lease_id: 'L-spent', cost_usd: 10 },
      });
      expect(await claim(db, team)).toEqual([]);
    });

    it("an agent's message to an on-shift seat at its cap is still rationed", async () => {
      const { db, team, ada, bob } = await seed();
      await atCap(db, team);
      await startShift(db, team.id, ada, 'nick', null, Date.now());
      await msg(db, team, bob, ada, 'handoff', 'h-bob');
      expect(await claim(db, team)).toEqual([]);
    });
  });

  it('off shift, a claimed lane wakes nothing', async () => {
    const { db, team } = await seed();
    await claimedLane(db, team);
    expect(await claim(db, team)).toEqual([]);
  });

  it("a person's Stop is never a wake reason", async () => {
    const { db, team, nick, ada } = await seed({});
    await msg(db, team, nick, ada, 'steer', 's-stop', { quick_action: 'stop' });
    expect(await claim(db, team)).toEqual([]);
    await msg(db, team, nick, ada, 'steer', 's-start', { quick_action: 'start' });
    expect((await claim(db, team)).map((o) => o.act_id)).toEqual(['s-start']);
  });

  it('Start while a wake is live leases nothing extra this poll', async () => {
    const { db, team, ada } = await seed({});
    const lane = await claimedLane(db, team);
    await startShift(db, team.id, ada, 'nick', null, Date.now());
    expect((await claim(db, team)).map((o) => o.lane_id)).toEqual([lane.id]);
    // The first lease is live: the next poll leases nothing, shift or not.
    expect(await claim(db, team)).toEqual([]);
  });
});
