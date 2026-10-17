import { makeEnvelope, type Lane } from '@musterd/protocol';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { routeEnvelope } from '../protocol/route.js';
import { decideLanePatch } from '../sync/claim.js';
import { listAuditByAction } from './audit.js';
import { getLane, openLane, updateLane } from './lanes.js';
import { addMember, getMemberByName } from './members.js';
import { bindNode, bindSeatToNode } from './nodes.js';
import {
  PULL_GRANT_TTL_MS,
  afterPullClaim,
  assertPullGranted,
  getPullAnnouncement,
  hostServiceSeatName,
  offerPull,
  releaseDeadPulls,
  sweepPullWindows,
} from './pull.js';
import { enrollResidency, recordHostSeen } from './residency.js';
import type { MemberRow } from './rows.js';
import { createTeam, setPolicy, type TeamRow } from './teams.js';

let openStore: () => Promise<Driver>;

/** ADR 645 §4.3 — the band-2 pull: offer, window, grant, claim, release. */

const HOST = 'air';
// A fixed instant: 2026-10-17 14:00 UTC — a Friday, mid-day in every zone the team calendar uses.
const T0 = Date.UTC(2026, 9, 17, 14, 0, 0);

const DECL = {
  run: 'pnpm next:readout --since 2026-10-06',
  verdict_rule: 'MET when ranked hits ≥ 2× baseline',
  record: 'ADR 536 Consequences',
  expected_spend: 0,
};

async function fixture(opts: { role?: string } = {}) {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'dawn' });
  const hub = new Proxy({}, { get: () => () => undefined }) as Ctx['hub'];
  const ctx = {
    db,
    hub,
    config: resolveConfig({ db: ':memory:' }),
    rosterRoots: [],
  } as unknown as Ctx;
  const { row: nick } = await addMember(db, team, { name: 'nick', kind: 'human' });
  const { row: seat } = await addMember(db, team, {
    name: 'stanley',
    kind: 'agent',
    ...(opts.role ? { role: opts.role } : {}),
  });
  await enrollResidency(db, team.id, {
    member_id: seat.id,
    harness: 'claude-code',
    host: HOST,
    grant_id: null,
    authorized_by: 'nick',
  });
  await recordHostSeen(db, team.id, HOST, T0);
  const open = (input: Partial<Parameters<typeof openLane>[4]> = {}, at = T0 - 60_000) =>
    openLane(
      db,
      team.id,
      team.slug,
      'nick',
      { title: 'ADR 536 read', project: 'runtime', pre_registered: DECL, ...input },
      at,
    );
  return { db, team, ctx, nick, seat, open };
}

async function offersFor(db: Driver, teamId: string) {
  return listAuditByAction(db, teamId, 'residency.pull_offered');
}

withDrivers('pull', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  describe('the declaration in the store (ADR 645 §1–2)', () => {
    it('is stamped by and at from the opener, and refused where the anti-goal lives', async () => {
      const { db, team, open } = await fixture();
      const lane = await open();
      expect(lane.pre_registered).toMatchObject({ ...DECL, by: 'nick', at: T0 - 60_000 });
      expect((await getLane(db, team.id, lane.id, team.slug))!.pre_registered?.run).toBe(DECL.run);
      await expect(open({ risk: ['user-facing'] })).rejects.toThrow(/user-facing/);
      await expect(open({ risk: ['security'] })).rejects.toThrow(/security/);
      await expect(open({ stakes: 'high' })).rejects.toThrow(/high-stakes/);
    });

    it('rides lane_update: stamped, withdrawn with null, refused on a non-open lane or a risky patch', async () => {
      const { db, team } = await fixture();
      const plain = await openLane(
        db,
        team.id,
        team.slug,
        'nick',
        { title: 'p', project: 'runtime' },
        T0,
      );
      const declared = (await updateLane(
        db,
        team.id,
        plain.id,
        team.slug,
        { pre_registered: DECL },
        T0 + 1,
        undefined,
        { actor: 'stanley' },
      ))!;
      expect(declared.pre_registered).toMatchObject({ ...DECL, by: 'stanley', at: T0 + 1 });
      await expect(
        updateLane(db, team.id, plain.id, team.slug, { risk: ['security'] }, T0 + 2, undefined, {
          actor: 'nick',
        }),
      ).rejects.toThrow(/cannot be pre-registered/);
      const cleared = (await updateLane(
        db,
        team.id,
        plain.id,
        team.slug,
        { pre_registered: null },
        T0 + 3,
        undefined,
        { actor: 'nick' },
      ))!;
      expect(cleared.pre_registered).toBeUndefined();
      await updateLane(
        db,
        team.id,
        plain.id,
        team.slug,
        { owner_seat: 'stanley' },
        T0 + 4,
        undefined,
        {
          actor: 'stanley',
        },
      );
      await expect(
        updateLane(db, team.id, plain.id, team.slug, { pre_registered: DECL }, T0 + 5, undefined, {
          actor: 'stanley',
        }),
      ).rejects.toThrow(/is claimed/);
    });
  });

  describe('who may declare, and which node may be offered (security review, 2026-10-17)', () => {
    it('only the opener or an admin sets, replaces or withdraws the declaration', async () => {
      const { db, team } = await fixture();
      await addMember(db, team, { name: 'dolly', kind: 'agent' });
      const plain = await openLane(
        db,
        team.id,
        team.slug,
        'nick',
        { title: 'p', project: 'runtime' },
        T0,
      );
      const dolly = { name: 'dolly', kind: 'agent' };
      await expect(
        decideLanePatch(db, team.id, dolly, plain, { pre_registered: DECL }, 60_000),
      ).rejects.toThrow(/only the opener/);
      await expect(
        decideLanePatch(
          db,
          team.id,
          { name: 'nick', kind: 'human' },
          plain,
          { pre_registered: DECL },
          60_000,
        ),
      ).resolves.toBeDefined();
    });

    it("a joiner's forwarded poll is offered only seats bound to that node", async () => {
      const { db, team, ctx, open, seat, nick } = await fixture();
      await open();
      await bindNode(db, team.id, 'node-a', 'laptop', 'msnode_node-a', nick.name);
      await bindNode(db, team.id, 'node-b', 'other', 'msnode_node-b', nick.name);
      await bindSeatToNode(db, team.id, seat.id, 'node-a', T0);
      expect((await offerPull(ctx, team, HOST, T0, 'node-b')).offer).toBeNull();
      expect((await offerPull(ctx, team, HOST, T0, 'node-a')).offer?.seat).toBe('stanley');
    });
  });

  describe('offer (§4.3, §8)', () => {
    it('offers an eligible declared lane and announces it to the opener as an advisory ask', async () => {
      const { db, team, ctx, open } = await fixture();
      const lane = await open();
      const res = await offerPull(ctx, team, HOST, T0);
      expect(res.offer).not.toBeNull();
      expect(res.offer!.lane).toBe(lane.id);
      expect(res.offer!.seat).toBe('stanley');
      expect(res.offer!.state).toBe('announced');
      expect(res.offer!.tier).toBe('advisory');
      expect(res.offer!.announced_by).toBe(hostServiceSeatName(HOST));
      expect(res.offer!.window_ends_at).toBe(T0 + 180_000);
      const ask = await db.get<{
        act: string;
        to_member: string;
        meta: string;
        from_member: string;
      }>('SELECT act, to_member, meta, from_member FROM messages WHERE id = ?', [res.offer!.ask]);
      expect(ask?.act).toBe('ask');
      const nick = (await getMemberByName(db, team.id, 'nick'))!;
      expect(ask?.to_member).toBe(nick.id);
      const meta = JSON.parse(ask!.meta);
      expect(meta.species).toBe('consult');
      expect(meta.tier).toBe('advisory');
      expect(meta.pull.lane).toBe(lane.id);
      const voice = (await getMemberByName(db, team.id, hostServiceSeatName(HOST)))!;
      expect(voice.kind).toBe('service');
      expect(ask?.from_member).toBe(voice.id);
      expect((await offersFor(db, team.id)).length).toBe(1);
    });

    it('withholds a dated read until its day, then offers it', async () => {
      const { team, ctx, open } = await fixture();
      await open({ reads_on: '2026-10-20' });
      expect((await offerPull(ctx, team, HOST, T0)).offer).toBeNull();
      const onTheDay = Date.UTC(2026, 9, 20, 14, 0, 0);
      expect((await offerPull(ctx, team, HOST, onTheDay)).offer).not.toBeNull();
    });

    it('never offers an undeclared, owned, or non-open lane', async () => {
      const { db, team, ctx, open } = await fixture();
      await openLane(
        db,
        team.id,
        team.slug,
        'nick',
        { title: 'plain', project: 'runtime' },
        T0 - 1,
      );
      await open({ claim: true });
      expect((await offerPull(ctx, team, HOST, T0)).offer).toBeNull();
    });

    it('offers a role lane only to a host holding a seat with that role', async () => {
      const a = await fixture();
      await a.open({ role: 'reviewer' });
      expect((await offerPull(a.ctx, a.team, HOST, T0)).offer).toBeNull();
      const b = await fixture({ role: 'reviewer' });
      await b.open({ role: 'reviewer' });
      expect((await offerPull(b.ctx, b.team, HOST, T0)).offer?.seat).toBe('stanley');
    });

    it('announces standard, with the longer window, when expected_spend is over the cap', async () => {
      const { team, ctx, open } = await fixture();
      await open({ pre_registered: { ...DECL, expected_spend: 12 } });
      const res = await offerPull(ctx, team, HOST, T0);
      expect(res.offer?.tier).toBe('standard');
      expect(res.offer?.window_ends_at).toBe(T0 + 300_000);
    });

    it('holds one announcement in flight per host and returns it on the next poll', async () => {
      const { team, ctx, open } = await fixture();
      await open();
      await open({ title: 'second' });
      const first = await offerPull(ctx, team, HOST, T0);
      const again = await offerPull(ctx, team, HOST, T0 + 1000);
      expect(again.offer?.id).toBe(first.offer?.id);
    });

    it('stops offering a seat past its daily cap', async () => {
      const { db, team, ctx, open } = await fixture();
      await setPolicy(db, team.id, { pull: { daily_cap_per_seat: 1 } });
      await open();
      await open({ title: 'second' });
      const first = await offerPull(ctx, team, HOST, T0);
      expect(first.offer).not.toBeNull();
      // Decline the first so nothing is in flight, then the cap alone withholds the second.
      await sweepPullWindows(ctx, team, T0 + 180_000 + 1);
      const row = (await getPullAnnouncement(db, team.id, first.offer!.id))!;
      expect(row.state).toBe('granted');
      await sweepPullWindows(ctx, team, T0 + 180_000 + PULL_GRANT_TTL_MS + 1);
      const res = await offerPull(ctx, team, HOST, T0 + 180_000 + PULL_GRANT_TTL_MS + 2);
      expect(res.offer).toBeNull();
      expect(res.idle_reason).toMatch(/room/);
    });
  });

  describe('window (§4.2)', () => {
    async function announced(ctx: Ctx, team: TeamRow) {
      const res = await offerPull(ctx, team, HOST, T0);
      return res.offer!;
    }

    it('grants on silence once the window lapses, never before', async () => {
      const { db, team, ctx, open } = await fixture();
      await open();
      const offer = await announced(ctx, team);
      expect(await sweepPullWindows(ctx, team, T0 + 179_999)).toEqual([]);
      const decided = await sweepPullWindows(ctx, team, T0 + 180_000);
      expect(decided).toEqual([
        { announcement: offer.id, lane: offer.lane, decision: 'granted', reason: null },
      ]);
      expect((await getPullAnnouncement(db, team.id, offer.id))!.state).toBe('granted');
    });

    it('a steer on the thread inside the window stops it, audited lane.pull_declined', async () => {
      const { db, team, ctx, open, nick } = await fixture();
      await open();
      const offer = await announced(ctx, team);
      await routeEnvelope(
        ctx,
        team,
        nick,
        makeEnvelope({
          id: 'steer-1',
          team: team.slug,
          from: 'nick',
          to: { kind: 'member', name: offer.announced_by },
          act: 'steer',
          body: 'not today',
          thread: offer.ask,
        }),
      );
      const decided = await sweepPullWindows(ctx, team, T0 + 180_000);
      expect(decided[0]?.decision).toBe('declined');
      expect(decided[0]?.reason).toBe('steer by nick');
      const rows = await listAuditByAction(db, team.id, 'lane.pull_declined');
      expect(rows.length).toBe(1);
      expect(JSON.parse(rows[0]!.detail!).reason).toBe('steer by nick');
    });

    it('a claim by anyone inside the window stops it', async () => {
      const { db, team, ctx, open } = await fixture();
      const lane = await open();
      const offer = await announced(ctx, team);
      await addMember(db, team, { name: 'dolly', kind: 'agent' });
      await updateLane(
        db,
        team.id,
        lane.id,
        team.slug,
        { owner_seat: 'dolly' },
        T0 + 1,
        undefined,
        {
          actor: 'dolly',
        },
      );
      const decided = await sweepPullWindows(ctx, team, T0 + 180_000);
      expect(decided[0]?.reason).toBe('claimed by dolly');
      expect((await getPullAnnouncement(db, team.id, offer.id))!.state).toBe('declined');
    });

    it('a withdrawn declaration or any other change to the lane inside the window stops it', async () => {
      const { db, team, ctx, open } = await fixture();
      const lane = await open();
      await announced(ctx, team);
      await updateLane(
        db,
        team.id,
        lane.id,
        team.slug,
        { pre_registered: null },
        T0 + 5,
        undefined,
        {
          actor: 'nick',
        },
      );
      expect((await sweepPullWindows(ctx, team, T0 + 180_000))[0]?.reason).toBe(
        'declaration withdrawn',
      );
      const second = await open({ title: 'another' });
      await offerPull(ctx, team, HOST, T0 + 200_000);
      await updateLane(
        db,
        team.id,
        second.id,
        team.slug,
        { detail: 'edited' },
        T0 + 200_001,
        undefined,
        {
          actor: 'nick',
        },
      );
      expect((await sweepPullWindows(ctx, team, T0 + 380_000))[0]?.reason).toBe(
        'lane changed during the window',
      );
    });

    it('a grant nobody redeems is declined after its TTL and the lane is offered again', async () => {
      const { db, team, ctx, open } = await fixture();
      await open();
      const offer = await announced(ctx, team);
      await sweepPullWindows(ctx, team, T0 + 180_000);
      const decided = await sweepPullWindows(ctx, team, T0 + 180_000 + PULL_GRANT_TTL_MS);
      expect(decided[0]?.reason).toBe('grant not redeemed');
      expect((await getPullAnnouncement(db, team.id, offer.id))!.state).toBe('declined');
      const again = await offerPull(ctx, team, HOST, T0 + 180_000 + PULL_GRANT_TTL_MS + 1);
      expect(again.offer?.lane).toBe(offer.lane);
      expect(again.offer?.id).not.toBe(offer.id);
    });
  });

  describe('claim (§4.3 step 3) and the record (§4.5)', () => {
    const pick = (offer: { ask: string; announced_by: string }) => ({
      via: 'pull' as const,
      requested_by: offer.announced_by,
      attested: false,
      ask: offer.ask,
      at: T0,
    });

    it('refuses a pull claim before the grant, for another pair, or after a decline', async () => {
      const { db, team, ctx, open, seat } = await fixture();
      const lane = await open();
      const offer = (await offerPull(ctx, team, HOST, T0)).offer!;
      await expect(assertPullGranted(db, team.id, lane.id, seat, pick(offer))).rejects.toThrow(
        /not lapsed/,
      );
      await sweepPullWindows(ctx, team, T0 + 180_000);
      const other = await open({ title: 'other' });
      await expect(assertPullGranted(db, team.id, other.id, seat, pick(offer))).rejects.toThrow(
        /another \(lane, seat\)/,
      );
      const stranger: MemberRow = { ...seat, id: 'x', name: 'x' };
      await expect(assertPullGranted(db, team.id, lane.id, stranger, pick(offer))).rejects.toThrow(
        /another/,
      );
      await expect(
        assertPullGranted(db, team.id, lane.id, seat, { ...pick(offer), requested_by: 'nick' }),
      ).rejects.toThrow(/requested_by/);
      await expect(
        assertPullGranted(db, team.id, lane.id, seat, pick(offer)),
      ).resolves.toMatchObject({
        state: 'granted',
      });
    });

    it('a landed claim marks the announcement claimed, writes lane.pulled, and sends the work order', async () => {
      const { db, team, ctx, open, seat } = await fixture();
      const lane = await open();
      const offer = (await offerPull(ctx, team, HOST, T0)).offer!;
      await sweepPullWindows(ctx, team, T0 + 180_000);
      const claimed = (await updateLane(
        db,
        team.id,
        lane.id,
        team.slug,
        { owner_seat: 'stanley', pick: pick(offer) },
        T0 + 181_000,
        undefined,
        { actor: 'stanley' },
      ))!;
      await afterPullClaim(ctx, team, claimed, 'stanley', offer.ask, T0 + 181_000);
      expect((await getPullAnnouncement(db, team.id, offer.id))!.state).toBe('claimed');
      const pulled = await listAuditByAction(db, team.id, 'lane.pulled');
      expect(pulled.length).toBe(1);
      expect(JSON.parse(pulled[0]!.detail!)).toMatchObject({
        lane: lane.id,
        seat: 'stanley',
        host: HOST,
        ask: offer.ask,
      });
      expect((await listAuditByAction(db, team.id, 'residency.pull_claimed')).length).toBe(1);
      const order = await db.get<{ act: string; meta: string }>(
        `SELECT act, meta FROM messages WHERE to_member = ? AND act = 'handoff'`,
        [seat.id],
      );
      expect(order).toBeDefined();
      expect(JSON.parse(order!.meta).lane_handoff.lane).toBe(lane.id);
    });
  });

  describe('release on a dead host (§5)', () => {
    async function pulled(ctx: Ctx, team: TeamRow, db: Driver, lane: Lane) {
      const offer = (await offerPull(ctx, team, HOST, T0)).offer!;
      await sweepPullWindows(ctx, team, T0 + 180_000);
      const claimed = (await updateLane(
        db,
        team.id,
        lane.id,
        team.slug,
        {
          owner_seat: 'stanley',
          pick: {
            via: 'pull',
            requested_by: offer.announced_by,
            attested: false,
            ask: offer.ask,
            at: T0,
          },
        },
        T0 + 181_000,
        undefined,
        { actor: 'stanley' },
      ))!;
      await afterPullClaim(ctx, team, claimed, 'stanley', offer.ask, T0 + 181_000);
      return offer;
    }

    it('releases after the third expired wake lease, audited, and the lane can be pulled again', async () => {
      const { db, team, ctx, open, seat } = await fixture();
      const lane = await open();
      await pulled(ctx, team, db, lane);
      for (let i = 0; i < 3; i++) {
        await db.run(
          `INSERT INTO wake_leases (id, team_id, member_id, act_id, lane_id, host, lane, status, created_at, expires_at)
           VALUES (?, ?, ?, NULL, ?, ?, 'batched', 'expired', ?, ?)`,
          [`lease-${i}`, team.id, seat.id, lane.id, HOST, T0 + 200_000 + i, T0 + 300_000 + i],
        );
        if (i < 2) expect(await releaseDeadPulls(ctx, team, T0 + 400_000)).toEqual([]);
      }
      const released = await releaseDeadPulls(ctx, team, T0 + 400_000);
      expect(released.length).toBe(1);
      expect(released[0]?.reason).toMatch(/3 expired wake leases/);
      const after = (await getLane(db, team.id, lane.id, team.slug))!;
      expect(after.owner_seat).toBeNull();
      expect(after.state).toBe('open');
      expect((await listAuditByAction(db, team.id, 'lane.pull_released')).length).toBe(1);
      expect((await offerPull(ctx, team, HOST, T0 + 400_001)).offer?.lane).toBe(lane.id);
    });

    it('releases after the host has been absent past the policy window', async () => {
      const { db, team, ctx, open } = await fixture();
      const lane = await open();
      await pulled(ctx, team, db, lane);
      expect(await releaseDeadPulls(ctx, team, T0 + 2 * 3_600_000 - 1)).toEqual([]);
      const released = await releaseDeadPulls(ctx, team, T0 + 2 * 3_600_000);
      expect(released[0]?.reason).toMatch(/absent/);
    });

    it('never releases a lane the seat no longer holds, or one not pulled', async () => {
      const { db, team, ctx, open } = await fixture();
      const lane = await open();
      await pulled(ctx, team, db, lane);
      await updateLane(
        db,
        team.id,
        lane.id,
        team.slug,
        { state: 'done' },
        T0 + 190_000,
        undefined,
        {
          actor: 'stanley',
        },
      );
      expect(await releaseDeadPulls(ctx, team, T0 + 3 * 3_600_000)).toEqual([]);
    });
  });
});
