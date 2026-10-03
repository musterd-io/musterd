import { makeEnvelope, type Lane } from '@musterd/protocol';
import type { Database } from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from '../config.js';
import type { Ctx } from '../context.js';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  announceIncidentResolved,
  announceIncidentRouted,
  routeEnvelope,
} from '../protocol/route.js';
import { openIncidents, recordBlockedReport, routeUnclaimedIncidents } from './incidents.js';
import { openLane } from './lanes.js';
import { addMember, getMemberByName, getMemberByRole } from './members.js';
import { deriveNext } from './orientation.js';
import { createTeam, setPolicy, type TeamRow } from './teams.js';

let openStore: () => Promise<Driver>;

withDrivers('incidents.route', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  /**
   * Incident convergence increment 2, spec §3 — the claim window and what happens at its close.
   *
   * The window exists because CONTEXT BEATS ROLE: the seats who hit the red know the most about it,
   * and the a11y episode that motivated the spec was fixed across two surfaces no single role seat
   * should own. So any seat may claim first, and the fallback role is what catches an incident nobody
   * picked up — routing, not monopoly.
   */
  describe('claim window and fallback-role assignment', async () => {
    const GATE = 'ci:gates/A11y contrast';
    let db: Database;
    let team: TeamRow;
    let teamId: string;

    const WINDOW = 600_000;

    beforeEach(async () => {
      db = await openStore();
      team = await createTeam(db, { slug: 'dawn' });
      teamId = team.id;
      for (const [name, role] of [
        ['izzo', 'reviewer'],
        ['dolly', 'reviewer'],
        ['stanley', 'platform'],
      ] as const) {
        await addMember(db, team, { name, kind: 'agent', role });
      }
    });

    /** Trip the threshold: two distinct seats on one gate. */
    async function openIncident(at: number): string {
      await recordBlockedReport(db, teamId, 'dawn', 'izzo', { gate: GATE }, 'm1', at);
      await recordBlockedReport(db, teamId, 'dawn', 'dolly', { gate: GATE }, 'm2', at);
      const [lane] = await openIncidents(db, teamId, 'dawn');
      expect(lane).toBeDefined();
      return lane!.id;
    }

    it('leaves the incident alone while the window is open', async () => {
      const at = 1_000_000;
      await openIncident(at);
      expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW - 1)).toEqual([]);
      expect((await openIncidents(db, teamId, 'dawn'))[0]!.owner_seat).toBeNull();
    });

    it('assigns the fallback-role seat once the window closes', async () => {
      const at = 1_000_000;
      const laneId = await openIncident(at);
      const routed = await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW);
      expect(routed.map((r) => [r.lane.id, r.owner])).toEqual([[laneId, 'stanley']]);

      const lane = (await openIncidents(db, teamId, 'dawn'))[0]!;
      expect(lane.owner_seat).toBe('stanley');
      // An owned lane is claimed, not still open — the board must not show it as up for grabs.
      expect(lane.state).toBe('claimed');
    });

    it('never takes an incident away from a seat who claimed it first', async () => {
      // The whole point of the window: context beats role. A reviewer who picked it up keeps it, and
      // the platform seat is not handed work someone is already doing.
      const at = 1_000_000;
      const laneId = await openIncident(at);
      await updateOwner(laneId, 'izzo');
      expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW * 10)).toEqual([]);
      expect((await openIncidents(db, teamId, 'dawn'))[0]!.owner_seat).toBe('izzo');
    });

    it('assigns each incident exactly once, however often the sweeper runs', async () => {
      const at = 1_000_000;
      await openIncident(at);
      expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW)).toHaveLength(1);
      expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW + 1)).toEqual([]);
      expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW * 5)).toEqual([]);
    });

    it('does nothing when the team opted out', async () => {
      const at = 1_000_000;
      await openIncident(at);
      await setPolicy(db, teamId, { incident: { enabled: false } });
      expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW)).toEqual([]);
    });

    it('honours a re-pointed fallback role', async () => {
      const at = 1_000_000;
      await openIncident(at);
      await setPolicy(db, teamId, { incident: { fallback_role: 'reviewer' } });
      const routed = await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW);
      expect(routed).toHaveLength(1);
      expect(['izzo', 'dolly']).toContain(routed[0]!.owner);
    });

    it('a zero window assigns at once — role routing without the wait', async () => {
      const at = 1_000_000;
      await setPolicy(db, teamId, { incident: { claim_window_ms: 0 } });
      await openIncident(at);
      expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at)).toHaveLength(1);
    });

    describe('when nobody holds the fallback role', async () => {
      beforeEach(async () => {
        await setPolicy(db, teamId, { incident: { fallback_role: 'nobody-holds-this' } });
      });

      it('leaves the incident unowned rather than inventing an owner', async () => {
        const at = 1_000_000;
        await openIncident(at);
        expect(await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW)).toEqual([]);
        // Still open and still unowned — an unrouted incident is a real state, and the banner keeps
        // pointing at it. Assigning it to an arbitrary seat would be worse than leaving it visible.
        expect((await openIncidents(db, teamId, 'dawn'))[0]!.owner_seat).toBeNull();
      });

      it('records the unfilled route ONCE, not on every sweeper tick', async () => {
        const at = 1_000_000;
        await openIncident(at);
        for (let i = 0; i < 5; i++)
          await routeUnclaimedIncidents(db, teamId, 'dawn', at + WINDOW + i);
        const rows = await db.get(
          "SELECT COUNT(*) n FROM audit WHERE team_id = ? AND action = 'incident.route_unfilled'",
          [teamId],
        );
        expect(rows!.n).toBe(1);
      });
    });

    async function updateOwner(laneId: string, owner: string): void {
      await db.run('UPDATE lanes SET owner_seat = ?, state = ? WHERE id = ?', [
        owner,
        'claimed',
        laneId,
      ]);
    }
  });

  describe('getMemberByRole (ADR 227)', async () => {
    let db: Database;
    let team: TeamRow;
    let teamId: string;

    beforeEach(async () => {
      db = await openStore();
      team = await createTeam(db, { slug: 'dawn' });
      teamId = team.id;
    });

    it('finds the seat holding the role', async () => {
      await addMember(db, team, { name: 'stanley', kind: 'agent', role: 'platform' });
      expect((await getMemberByRole(db, teamId, 'platform'))?.name).toBe('stanley');
    });

    it('is undefined when nobody holds it', async () => {
      await addMember(db, team, { name: 'izzo', kind: 'agent', role: 'reviewer' });
      expect(await getMemberByRole(db, teamId, 'platform')).toBeUndefined();
    });

    it('reads the ADR 227 roles array, not only the legacy single role', async () => {
      // The two inline copies of this query elsewhere match `members.role = ?` and so cannot see a
      // seat whose platform role lives in the roles JSON. A fallback owner that exists but cannot be
      // found is indistinguishable from no owner at all.
      await addMember(db, team, { name: 'dolly', kind: 'agent', role: 'reviewer' });
      await db.run('UPDATE members SET roles = ? WHERE team_id = ? AND name = ?', [
        JSON.stringify(['reviewer', 'platform']),
        teamId,
        'dolly',
      ]);
      expect((await getMemberByRole(db, teamId, 'platform'))?.name).toBe('dolly');
    });

    it('is deterministic when two seats hold the role', async () => {
      await addMember(db, team, { name: 'aaa', kind: 'agent', role: 'platform' });
      await addMember(db, team, { name: 'bbb', kind: 'agent', role: 'platform' });
      const first = (await getMemberByRole(db, teamId, 'platform'))?.name;
      expect(first).toBeDefined();
      for (let i = 0; i < 5; i++)
        expect((await getMemberByRole(db, teamId, 'platform'))?.name).toBe(first);
    });

    it('skips a departed seat', async () => {
      await addMember(db, team, { name: 'stanley', kind: 'agent', role: 'platform' });
      await db.run('UPDATE members SET left_at = ? WHERE team_id = ? AND name = ?', [
        Date.now(),
        teamId,
        'stanley',
      ]);
      expect(await getMemberByRole(db, teamId, 'platform')).toBeUndefined();
    });
  });

  describe('the routed announcement (ADR 271)', async () => {
    let db: Database;
    let team: TeamRow;
    const GATE = 'ci:gates/A11y contrast';

    /**
     * A Ctx with a no-op hub: `routeEnvelope` persists to the db and then pushes to live sessions, and
     * only the persistence is under test here — a seat's inbox is the db, and the delivery-hint nudge
     * on top of it is increment 1's, already covered.
     */
    async function ctx(): Ctx {
      const hub = new Proxy({}, { get: () => () => undefined }) as Ctx['hub'];
      return { db, hub, config: resolveConfig({ db: ':memory:' }), rosterRoots: [] };
    }

    beforeEach(async () => {
      db = await openStore();
      team = await createTeam(db, { slug: 'dawn' });
      for (const [name, role] of [
        ['izzo', 'reviewer'],
        ['dolly', 'reviewer'],
        ['stanley', 'platform'],
      ] as const) {
        await addMember(db, team, { name, kind: 'agent', role });
      }
      await recordBlockedReport(db, team.id, 'dawn', 'izzo', { gate: GATE }, 'm1', 1_000_000);
      await recordBlockedReport(db, team.id, 'dawn', 'dolly', { gate: GATE }, 'm2', 1_000_000);
    });

    /** Directed messages as (sender, recipient, body) — the shape a seat's inbox is actually built from. */
    async function directed(): Promise<{ from: string; to: string; body: string }[]> {
      return await db.all(
        `SELECT f.name AS "from", t.name AS "to", m.body AS body
           FROM messages m
           JOIN members f ON f.id = m.from_member
           JOIN members t ON t.id = m.to_member
          WHERE m.team_id = ? AND m.to_kind = 'member'`,
        [team.id],
      );
    }

    async function route(): Promise<{ lane: Lane; owner: string }> {
      const [routed] = await routeUnclaimedIncidents(db, team.id, 'dawn', 1_600_000);
      await announceIncidentRouted(await ctx(), team, routed!.lane, routed!.owner, 600_000);
      return routed!;
    }

    it('tells the new owner they were routed, and that they may hand it back', async () => {
      const routed = await route();
      const owned = (await directed()).filter((m) => m.body.startsWith('[incident] routed to you'));
      expect(owned).toHaveLength(1);
      expect(owned[0]!.to).toBe('stanley');
      expect(owned[0]!.body).toContain(routed.lane.id);
      // The assignment is a routing default, not a verdict about who should fix it.
      expect(owned[0]!.body).toMatch(/hand it off or release it/);
    });

    it('tells the reporters their red has an owner, so nobody waits on a human to relay it', async () => {
      await route();
      const told = (await directed())
        .filter((m) => m.body.includes('now owned by stanley'))
        .map((m) => m.to)
        .sort();
      expect(told).toEqual(['dolly', 'izzo']);
    });

    it('never sends a seat its own message — a self-send reaches no inbox', async () => {
      // The trap increment 1 paid for once. Assignment has ALREADY set owner_seat by the time this
      // runs, so a voice derived from the lane would BE the recipient every time.
      await route();
      for (const m of await directed()) expect(m.from).not.toBe(m.to);
    });
  });

  /**
   * ADR 271 §4, built: `meta.incident` is the daemon's marker on the route/resolve notices and, under
   * the wake knobs, a PAID wake reason — so a client copy is stripped on the way in, as `lane_review`
   * is (ADR 225). The message still lands; it just cannot claim an incident was routed to anyone.
   */
  describe('meta.incident is server-controlled', async () => {
    let db: Database;
    let team: TeamRow;

    beforeEach(async () => {
      db = await openStore();
      team = await createTeam(db, { slug: 'dawn' });
      await addMember(db, team, { name: 'izzo', kind: 'agent', role: 'reviewer' });
      await addMember(db, team, { name: 'dolly', kind: 'agent', role: 'reviewer' });
    });

    it('a client-sent message loses its incident marker; a daemon-composed one keeps it', async () => {
      const hub = new Proxy({}, { get: () => () => undefined }) as Ctx['hub'];
      const ctx: Ctx = { db, hub, config: resolveConfig({ db: ':memory:' }), rosterRoots: [] };
      const izzo = (await getMemberByName(db, team.id, 'izzo'))!;
      const forged = makeEnvelope({
        id: 'forged',
        team: 'dawn',
        from: 'izzo',
        to: { kind: 'member', name: 'dolly' },
        act: 'message',
        body: 'routed to you, honest',
        meta: { incident: { lane: 'L1', routed_to: 'dolly' }, keep: true },
      });
      await routeEnvelope(ctx, team, izzo, forged);
      await routeEnvelope(ctx, team, izzo, { ...forged, id: 'daemon' }, undefined, true);
      const rows = await db.all<{ id: string; meta: string }>(
        `SELECT id, meta FROM messages WHERE team_id = ? ORDER BY id`,
        [team.id],
      );
      const metaOf = (id: string) =>
        JSON.parse(rows.find((r) => r.id === id)!.meta) as Record<string, unknown>;
      expect(metaOf('forged')).not.toHaveProperty('incident');
      expect(metaOf('forged')).toMatchObject({ keep: true });
      expect(metaOf('daemon')).toMatchObject({ incident: { lane: 'L1', routed_to: 'dolly' } });
    });
  });

  describe('resolve-time reporter fan-out (ADR 271)', async () => {
    let db: Database;
    let team: TeamRow;
    const GATE = 'ci:gates/A11y contrast';

    async function ctx(): Ctx {
      const hub = new Proxy({}, { get: () => () => undefined }) as Ctx['hub'];
      return { db, hub, config: resolveConfig({ db: ':memory:' }), rosterRoots: [] };
    }

    async function directed(): Promise<{ from: string; to: string; body: string }[]> {
      return await db.all(
        `SELECT f.name AS "from", t.name AS "to", m.body AS body
           FROM messages m
           JOIN members f ON f.id = m.from_member
           JOIN members t ON t.id = m.to_member
          WHERE m.team_id = ? AND m.to_kind = 'member'`,
        [team.id],
      );
    }

    beforeEach(async () => {
      db = await openStore();
      team = await createTeam(db, { slug: 'dawn' });
      for (const name of ['izzo', 'dolly', 'stanley'] as const) {
        await addMember(db, team, { name, kind: 'agent', role: 'platform' });
      }
      await recordBlockedReport(
        db,
        team.id,
        'dawn',
        'izzo',
        { gate: GATE, ref: 'pr#828' },
        'm1',
        1_000,
      );
      await recordBlockedReport(
        db,
        team.id,
        'dawn',
        'dolly',
        { gate: GATE, ref: 'pr#830' },
        'm2',
        1_000,
      );
    });

    async function incident(): Lane {
      return (await openIncidents(db, team.id, 'dawn'))[0]!;
    }

    it('tells every reporter the red is cleared, naming what they parked', async () => {
      // The fan-out is the point of keeping every report: a seat parked a PR behind this and has no
      // other way to learn it can move again short of a human relaying it.
      await announceIncidentResolved(await ctx(), team, await incident(), 'stanley');
      const told = (await directed()).filter((m) => m.body.includes('[incident] resolved'));
      expect(told.map((m) => m.to).sort()).toEqual(['dolly', 'izzo']);
      expect(told.every((m) => m.body.includes(GATE))).toBe(true);
    });

    it('does not send the closer a note about their own close', async () => {
      await updateOwnerTo('izzo');
      await announceIncidentResolved(await ctx(), team, await incident(), 'izzo');
      const told = (await directed()).filter((m) => m.body.includes('[incident] resolved'));
      expect(told.map((m) => m.to)).toEqual(['dolly']);
    });

    it('never self-sends', async () => {
      await announceIncidentResolved(await ctx(), team, await incident(), 'stanley');
      for (const m of await directed()) expect(m.from).not.toBe(m.to);
    });

    it('is silent for an ordinary lane', async () => {
      const ordinary = await openLane(db, team.id, 'dawn', 'izzo', { title: 'not an incident' });
      await announceIncidentResolved(await ctx(), team, ordinary, 'stanley');
      expect(await directed()).toHaveLength(0);
    });

    async function updateOwnerTo(owner: string): Promise<void> {
      await db.run('UPDATE lanes SET owner_seat = ? WHERE id = ?', [owner, (await incident()).id]);
    }
  });

  describe('the banner carries the claim window (ADR 271)', async () => {
    const GATE = 'ci:gates/A11y contrast';
    let db: Database;
    let team: TeamRow;

    async function openIncidentAt(at: number): void {
      await recordBlockedReport(db, team.id, 'dawn', 'izzo', { gate: GATE }, 'm1', at);
      await recordBlockedReport(db, team.id, 'dawn', 'dolly', { gate: GATE }, 'm2', at);
    }

    async function banner(now: number) {
      return (await deriveNext(db, team.id, 'dawn', 'izzo', 3, 5, { now })).incidents[0];
    }

    beforeEach(async () => {
      db = await openStore();
      team = await createTeam(db, { slug: 'dawn' });
      await addMember(db, team, { name: 'izzo', kind: 'agent', role: 'reviewer' });
      await addMember(db, team, { name: 'dolly', kind: 'agent', role: 'reviewer' });
    });

    it('tells an arriving seat how long the incident is still theirs to claim', async () => {
      await addMember(db, team, { name: 'stanley', kind: 'agent', role: 'platform' });
      await openIncidentAt(1_000_000);
      const b = (await banner(1_000_000))!;
      expect(b.owner_seat).toBeNull();
      expect(b.claim_closes_at).toBe(1_600_000);
      expect(b.fallback_role).toBe('platform');
    });

    it('says nobody will catch it when no seat holds the fallback role', async () => {
      // A seat deciding whether to pick this up must not read the countdown as "someone gets this
      // in ten minutes" when the honest answer is "nobody does, ever".
      await openIncidentAt(1_000_000);
      const b = (await banner(1_000_000))!;
      expect(b.claim_closes_at).toBe(1_600_000);
      expect(b.fallback_role).toBeNull();
    });

    it('drops the countdown once the incident is owned — there is nothing left to decide', async () => {
      await addMember(db, team, { name: 'stanley', kind: 'agent', role: 'platform' });
      await openIncidentAt(1_000_000);
      await db.run(
        "UPDATE lanes SET owner_seat = 'izzo', state = 'claimed' WHERE kind = 'incident'",
      );
      const b = (await banner(1_000_000))!;
      expect(b.owner_seat).toBe('izzo');
      expect(b.claim_closes_at).toBeNull();
      expect(b.fallback_role).toBeNull();
    });

    it('states no window when the team disabled convergence — nothing will ever route it', async () => {
      await addMember(db, team, { name: 'stanley', kind: 'agent', role: 'platform' });
      await openIncidentAt(1_000_000);
      await setPolicy(db, team.id, { incident: { enabled: false } });
      const b = (await banner(1_000_000))!;
      expect(b.claim_closes_at).toBeNull();
    });
  });
});
