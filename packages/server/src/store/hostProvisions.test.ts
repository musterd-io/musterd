import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  claimProvisions,
  getProvision,
  insertProvision,
  liveHostedCount,
  PROVISION_PENDING_TTL_MS,
  reportProvision,
  sponsorHostsSeen,
  sweepProvisions,
} from './hostProvisions.js';
import { addMember, leaveMember, setMemberGovernance } from './members.js';
import {
  enrollResidency,
  type HostScope,
  recordHostSeen,
  TEAM_WIDE_HOST,
  takeProvisionedWake,
} from './residency.js';
import { createSponsoredAgent } from './sponsoredAgents.js';
import { createTeam } from './teams.js';

let openStore: () => Promise<Driver>;

/** ADR 463 §2 — the store half of sponsor-host provisions. */

async function teamWithHumans() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'acme' });
  const { row: dana } = await addMember(db, team, { name: 'dana', kind: 'human' });
  const { row: eve } = await addMember(db, team, { name: 'eve', kind: 'human' });
  const scopeOf = (id: string): HostScope => ({ creatorId: id, teamWide: false });
  return { db, team, dana, eve, scopeOf };
}

withDrivers('hostProvisions', (o) => {
  // Set per test, not at collection: describe.each collects every driver before any test runs.
  beforeEach(() => {
    openStore = o;
  });

  describe('host provisions (ADR 463 §2)', async () => {
    it('insert → claim is atomic and one host wins', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { member: agent } = await createSponsoredAgent(db, team, dana, { name: 'scout' });
      const row = await insertProvision(db, team.id, agent.id, dana.id);
      expect(row.state).toBe('pending');
      const a = await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
      const b = await claimProvisions(db, team.id, 'h2', scopeOf(dana.id), 5);
      expect(a.map((r) => r.id)).toEqual([row.id]);
      expect(a[0]!.claimed_by).toBe('h1');
      expect(b).toEqual([]);
      expect((await getProvision(db, team.id, row.id))!.state).toBe('claimed');
    });

    // Lane 01M5DR34Y2: two live hosts of one sponsor raced for every row; a row pinned at insert
    // waits for the named host (2026-10-20: three machine stops to steer three canary provisions).
    it('a row pinned to a host is claimed only by that host; an unpinned row by any', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { member: a } = await createSponsoredAgent(db, team, dana, { name: 'pinned' });
      const { member: b } = await createSponsoredAgent(db, team, dana, { name: 'loose' });
      const pinned = await insertProvision(db, team.id, a.id, dana.id, Date.now(), null, 'h2');
      const loose = await insertProvision(db, team.id, b.id, dana.id);
      expect(pinned.host).toBe('h2');
      const byH1 = await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
      expect(byH1.map((r) => r.id)).toEqual([loose.id]);
      const byH2 = await claimProvisions(db, team.id, 'h2', scopeOf(dana.id), 5);
      expect(byH2.map((r) => r.id)).toEqual([pinned.id]);
      expect(byH2[0]!.claimed_by).toBe('h2');
    });

    it('a sponsor key claims only its own rows; a team-wide key claims no sponsored row', async () => {
      const { db, team, dana, eve, scopeOf } = await teamWithHumans();
      const { member: ds } = await createSponsoredAgent(db, team, dana, { name: 'dana-scout' });
      const { member: es } = await createSponsoredAgent(db, team, eve, { name: 'eve-scout' });
      const dRow = await insertProvision(db, team.id, ds.id, dana.id);
      await insertProvision(db, team.id, es.id, eve.id);
      expect(await claimProvisions(db, team.id, 'shared', TEAM_WIDE_HOST, 5)).toEqual([]);
      expect(
        (
          await claimProvisions(db, team.id, 'shared', { creatorId: dana.id, teamWide: true }, 5)
        ).map((r) => r.id),
      ).toEqual([dRow.id]);
      expect(await claimProvisions(db, team.id, 'shared', scopeOf(eve.id), 5)).toHaveLength(1);
    });

    it('max_per_host counts hosted seats and in-flight claims, and leaves the rest pending', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const agents = await Promise.all(
        ['a1', 'a2', 'a3'].map(
          async (name) =>
            (await createSponsoredAgent(db, team, dana, { name }, Date.now(), { cap: 10 })).member,
        ),
      );
      await enrollResidency(db, team.id, {
        member_id: agents[0]!.id,
        harness: 'claude-code',
        host: 'h1',
        grant_id: null,
        authorized_by: null,
      });
      expect(await liveHostedCount(db, team.id, 'h1')).toBe(1);
      const r2 = await insertProvision(db, team.id, agents[1]!.id, dana.id, 1000);
      const r3 = await insertProvision(db, team.id, agents[2]!.id, dana.id, 2000);
      expect(
        (await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 2)).map((r) => r.id),
      ).toEqual([r2.id]);
      expect(await liveHostedCount(db, team.id, 'h1')).toBe(2);
      expect(await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 2)).toEqual([]);
      expect((await getProvision(db, team.id, r3.id))!.state).toBe('pending');
    });

    it('ready sets ready_at; another host is conflict; a second report is conflict', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { member: agent } = await createSponsoredAgent(db, team, dana, { name: 'scout' });
      const row = await insertProvision(db, team.id, agent.id, dana.id);
      await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
      await expect(reportProvision(db, team.id, row.id, 'h2', { state: 'ready' })).rejects.toThrow(
        /not claimed by host "h2"/,
      );
      const r = await reportProvision(db, team.id, row.id, 'h1', { state: 'ready' }, 1234);
      expect(r.refused).toBeNull();
      expect(r.row.ready_at).toBe(1234);
      await expect(reportProvision(db, team.id, row.id, 'h1', { state: 'ready' })).rejects.toThrow(
        /already reported/,
      );
      await expect(reportProvision(db, team.id, 'nope', 'h1', { state: 'ready' })).rejects.toThrow(
        /no provision/,
      );
    });

    it('a failed report records the reason', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { member: agent } = await createSponsoredAgent(db, team, dana, { name: 'scout' });
      const row = await insertProvision(db, team.id, agent.id, dana.id);
      await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
      await reportProvision(db, team.id, row.id, 'h1', { state: 'failed', reason: 'worktree' });
      expect(await getProvision(db, team.id, row.id)).toMatchObject({
        state: 'failed',
        failed_reason: 'worktree',
      });
    });

    it('Review Focus 2: ready is refused, and the failure commits, once the sponsor lost standing', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { member: agent } = await createSponsoredAgent(db, team, dana, { name: 'scout' });
      const row = await insertProvision(db, team.id, agent.id, dana.id);
      await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
      await setMemberGovernance(db, dana.id, 'disabled', '{}');
      const r = await reportProvision(db, team.id, row.id, 'h1', { state: 'ready' });
      expect(r.refused).toBe('sponsor_lost_standing');
      expect(await getProvision(db, team.id, row.id)).toMatchObject({
        state: 'failed',
        failed_reason: 'sponsor_lost_standing',
      });
    });

    it('ready is refused once the agent left', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { member: agent } = await createSponsoredAgent(db, team, dana, { name: 'scout' });
      const row = await insertProvision(db, team.id, agent.id, dana.id);
      await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
      await leaveMember(db, agent.id);
      expect((await reportProvision(db, team.id, row.id, 'h1', { state: 'ready' })).refused).toBe(
        'agent_lost_standing',
      );
    });

    it('sweepProvisions settles every row that can no longer finish, and nothing else', async () => {
      const { db, team, dana, eve, scopeOf } = await teamWithHumans();
      const now = Date.now();
      const TTL = PROVISION_PENDING_TTL_MS;
      const mk = async (sponsor: typeof dana, name: string) =>
        (await createSponsoredAgent(db, team, sponsor, { name }, now, { cap: 10 })).member;
      const stale = await insertProvision(
        db,
        team.id,
        (await mk(dana, 'stale')).id,
        dana.id,
        now - TTL - 5,
      );
      await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 10, now - TTL - 1);
      await insertProvision(db, team.id, (await mk(dana, 'fresh')).id, dana.id, now - 60_000);
      const goneAgent = await mk(dana, 'gone');
      const gone = await insertProvision(db, team.id, goneAgent.id, dana.id, now);
      await leaveMember(db, goneAgent.id);
      const eves = await insertProvision(db, team.id, (await mk(eve, 'eves')).id, eve.id, now);
      await setMemberGovernance(db, eve.id, 'disabled', '{}');

      const swept = await sweepProvisions(db, now);
      const by = Object.fromEntries(swept.map((x) => [x.row.id, [x.reason, x.row.state]]));
      expect(by).toEqual({
        [stale.id]: ['not_reported', 'failed'],
        [gone.id]: ['agent_left', 'cancelled'],
        [eves.id]: ['sponsor_lost_standing', 'failed'],
      });
      expect(await sweepProvisions(db, now)).toEqual([]);
    });

    it('sweepProvisions leaves a team it is told to skip untouched', async () => {
      const { db, team, dana } = await teamWithHumans();
      const now = Date.now();
      const { member } = await createSponsoredAgent(db, team, dana, { name: 'remote' }, now);
      const row = await insertProvision(
        db,
        team.id,
        member.id,
        dana.id,
        now - PROVISION_PENDING_TTL_MS - 5,
      );
      expect(await sweepProvisions(db, now, new Set([team.id]))).toEqual([]);
      expect((await sweepProvisions(db, now)).map((x) => x.row.id)).toEqual([row.id]);
    });

    it('an unclaimed row past the TTL is cancelled unclaimed', async () => {
      const { db, team, dana } = await teamWithHumans();
      const now = Date.now();
      const { member } = await createSponsoredAgent(db, team, dana, { name: 'scout' }, now);
      const row = await insertProvision(
        db,
        team.id,
        member.id,
        dana.id,
        now - PROVISION_PENDING_TTL_MS,
      );
      expect(
        (await sweepProvisions(db, now)).map((x) => [x.row.id, x.reason, x.row.state]),
      ).toEqual([[row.id, 'unclaimed', 'cancelled']]);
    });

    it('sponsorHostsSeen returns labels this sponsor polled within 10 minutes; a team-wide poll keeps it', async () => {
      const { db, team, dana, eve } = await teamWithHumans();
      const now = Date.now();
      await recordHostSeen(db, team.id, 'h1', now, dana.id);
      await recordHostSeen(db, team.id, 'h1', now + 1, null);
      await recordHostSeen(db, team.id, 'old', now - 11 * 60_000, dana.id);
      await recordHostSeen(db, team.id, 'h2', now, eve.id);
      expect(await sponsorHostsSeen(db, team.id, dana.id, now + 1)).toEqual(['h1']);
    });

    it('a claim that does not name move leaves a move row pending', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { row: wallow } = await addMember(db, team, { name: 'wallow', kind: 'agent' });
      const now = Date.now();
      const moveJson = JSON.stringify({ harness: 'claude-code', policy: null });
      const move = await insertProvision(
        db,
        team.id,
        wallow.id,
        dana.id,
        now,
        null,
        'shared',
        'move',
        moveJson,
      );
      // A sponsor-scoped key cannot serve an unsponsored seat, even when it asks for moves.
      expect(
        await claimProvisions(db, team.id, 'shared', scopeOf(dana.id), 5, now, ['mint', 'move']),
      ).toEqual([]);
      // The default claim is mint-only, so a host that has not opted in never sees the row.
      expect(await claimProvisions(db, team.id, 'shared', TEAM_WIDE_HOST, 5, now)).toEqual([]);
      const claimed = await claimProvisions(db, team.id, 'shared', TEAM_WIDE_HOST, 5, now, [
        'mint',
        'move',
      ]);
      expect(claimed.map((r) => r.id)).toEqual([move.id]);
      expect(claimed[0]?.kind).toBe('move');
    });

    it('takeProvisionedWake ignores a ready move row', async () => {
      const { db, team, dana } = await teamWithHumans();
      const { row: wallow } = await addMember(db, team, { name: 'wallow', kind: 'agent' });
      const now = Date.now();
      const move = await insertProvision(
        db,
        team.id,
        wallow.id,
        dana.id,
        now,
        null,
        'shared',
        'move',
        JSON.stringify({ harness: 'claude-code', policy: null }),
      );
      await db.run("UPDATE host_provisions SET state = 'ready', ready_at = ? WHERE id = ?", [
        now,
        move.id,
      ]);
      expect(await takeProvisionedWake(db, team.id, wallow.id, now)).toBeUndefined();
    });

    it('takeProvisionedWake yields a ready row once', async () => {
      const { db, team, dana, scopeOf } = await teamWithHumans();
      const { member: agent } = await createSponsoredAgent(db, team, dana, { name: 'scout' });
      const row = await insertProvision(db, team.id, agent.id, dana.id);
      expect(await takeProvisionedWake(db, team.id, agent.id)).toBeUndefined();
      await claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
      await reportProvision(db, team.id, row.id, 'h1', { state: 'ready' });
      expect((await takeProvisionedWake(db, team.id, agent.id))?.id).toBe(row.id);
      expect(await takeProvisionedWake(db, team.id, agent.id)).toBeUndefined();
    });
  });
});
