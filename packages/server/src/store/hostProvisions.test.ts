import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
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

/** ADR 463 §2 — the store half of sponsor-host provisions. */

function teamWithHumans() {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'acme' });
  const { row: dana } = addMember(db, team, { name: 'dana', kind: 'human' });
  const { row: eve } = addMember(db, team, { name: 'eve', kind: 'human' });
  const scopeOf = (id: string): HostScope => ({ creatorId: id, teamWide: false });
  return { db, team, dana, eve, scopeOf };
}

describe('host provisions (ADR 463 §2)', () => {
  it('insert → claim is atomic and one host wins', () => {
    const { db, team, dana, scopeOf } = teamWithHumans();
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    const row = insertProvision(db, team.id, agent.id, dana.id);
    expect(row.state).toBe('pending');
    const a = claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
    const b = claimProvisions(db, team.id, 'h2', scopeOf(dana.id), 5);
    expect(a.map((r) => r.id)).toEqual([row.id]);
    expect(a[0]!.claimed_by).toBe('h1');
    expect(b).toEqual([]);
    expect(getProvision(db, team.id, row.id)!.state).toBe('claimed');
  });

  it('a sponsor key claims only its own rows; a team-wide key claims no sponsored row', () => {
    const { db, team, dana, eve, scopeOf } = teamWithHumans();
    const { member: ds } = createSponsoredAgent(db, team, dana, { name: 'dana-scout' });
    const { member: es } = createSponsoredAgent(db, team, eve, { name: 'eve-scout' });
    const dRow = insertProvision(db, team.id, ds.id, dana.id);
    insertProvision(db, team.id, es.id, eve.id);
    expect(claimProvisions(db, team.id, 'shared', TEAM_WIDE_HOST, 5)).toEqual([]);
    expect(
      claimProvisions(db, team.id, 'shared', { creatorId: dana.id, teamWide: true }, 5).map(
        (r) => r.id,
      ),
    ).toEqual([dRow.id]);
    expect(claimProvisions(db, team.id, 'shared', scopeOf(eve.id), 5)).toHaveLength(1);
  });

  it('max_per_host counts hosted seats and in-flight claims, and leaves the rest pending', () => {
    const { db, team, dana, scopeOf } = teamWithHumans();
    const agents = ['a1', 'a2', 'a3'].map(
      (name) => createSponsoredAgent(db, team, dana, { name }, Date.now(), { cap: 10 }).member,
    );
    enrollResidency(db, team.id, {
      member_id: agents[0]!.id,
      harness: 'claude-code',
      host: 'h1',
      grant_id: null,
      authorized_by: null,
    });
    expect(liveHostedCount(db, team.id, 'h1')).toBe(1);
    const r2 = insertProvision(db, team.id, agents[1]!.id, dana.id, 1000);
    const r3 = insertProvision(db, team.id, agents[2]!.id, dana.id, 2000);
    expect(claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 2).map((r) => r.id)).toEqual([
      r2.id,
    ]);
    expect(liveHostedCount(db, team.id, 'h1')).toBe(2);
    expect(claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 2)).toEqual([]);
    expect(getProvision(db, team.id, r3.id)!.state).toBe('pending');
  });

  it('ready sets ready_at; another host is conflict; a second report is conflict', () => {
    const { db, team, dana, scopeOf } = teamWithHumans();
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    const row = insertProvision(db, team.id, agent.id, dana.id);
    claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
    expect(() => reportProvision(db, team.id, row.id, 'h2', { state: 'ready' })).toThrow(
      /not claimed by host "h2"/,
    );
    const r = reportProvision(db, team.id, row.id, 'h1', { state: 'ready' }, 1234);
    expect(r.refused).toBeNull();
    expect(r.row.ready_at).toBe(1234);
    expect(() => reportProvision(db, team.id, row.id, 'h1', { state: 'ready' })).toThrow(
      /already reported/,
    );
    expect(() => reportProvision(db, team.id, 'nope', 'h1', { state: 'ready' })).toThrow(
      /no provision/,
    );
  });

  it('a failed report records the reason', () => {
    const { db, team, dana, scopeOf } = teamWithHumans();
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    const row = insertProvision(db, team.id, agent.id, dana.id);
    claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
    reportProvision(db, team.id, row.id, 'h1', { state: 'failed', reason: 'worktree' });
    expect(getProvision(db, team.id, row.id)).toMatchObject({
      state: 'failed',
      failed_reason: 'worktree',
    });
  });

  it('Review Focus 2: ready is refused, and the failure commits, once the sponsor lost standing', () => {
    const { db, team, dana, scopeOf } = teamWithHumans();
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    const row = insertProvision(db, team.id, agent.id, dana.id);
    claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
    setMemberGovernance(db, dana.id, 'disabled', '{}');
    const r = reportProvision(db, team.id, row.id, 'h1', { state: 'ready' });
    expect(r.refused).toBe('sponsor_lost_standing');
    expect(getProvision(db, team.id, row.id)).toMatchObject({
      state: 'failed',
      failed_reason: 'sponsor_lost_standing',
    });
  });

  it('ready is refused once the agent left', () => {
    const { db, team, dana, scopeOf } = teamWithHumans();
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    const row = insertProvision(db, team.id, agent.id, dana.id);
    claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
    leaveMember(db, agent.id);
    expect(reportProvision(db, team.id, row.id, 'h1', { state: 'ready' }).refused).toBe(
      'agent_lost_standing',
    );
  });

  it('sweepProvisions settles every row that can no longer finish, and nothing else', () => {
    const { db, team, dana, eve, scopeOf } = teamWithHumans();
    const now = Date.now();
    const TTL = PROVISION_PENDING_TTL_MS;
    const mk = (sponsor: typeof dana, name: string) =>
      createSponsoredAgent(db, team, sponsor, { name }, now, { cap: 10 }).member;
    const stale = insertProvision(db, team.id, mk(dana, 'stale').id, dana.id, now - TTL - 5);
    claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 10, now - TTL - 1);
    insertProvision(db, team.id, mk(dana, 'fresh').id, dana.id, now - 60_000);
    const goneAgent = mk(dana, 'gone');
    const gone = insertProvision(db, team.id, goneAgent.id, dana.id, now);
    leaveMember(db, goneAgent.id);
    const eves = insertProvision(db, team.id, mk(eve, 'eves').id, eve.id, now);
    setMemberGovernance(db, eve.id, 'disabled', '{}');

    const swept = sweepProvisions(db, now);
    const by = Object.fromEntries(swept.map((x) => [x.row.id, [x.reason, x.row.state]]));
    expect(by).toEqual({
      [stale.id]: ['not_reported', 'failed'],
      [gone.id]: ['agent_left', 'cancelled'],
      [eves.id]: ['sponsor_lost_standing', 'failed'],
    });
    expect(sweepProvisions(db, now)).toEqual([]);
  });

  it('an unclaimed row past the TTL is cancelled unclaimed', () => {
    const { db, team, dana } = teamWithHumans();
    const now = Date.now();
    const { member } = createSponsoredAgent(db, team, dana, { name: 'scout' }, now);
    const row = insertProvision(db, team.id, member.id, dana.id, now - PROVISION_PENDING_TTL_MS);
    expect(sweepProvisions(db, now).map((x) => [x.row.id, x.reason, x.row.state])).toEqual([
      [row.id, 'unclaimed', 'cancelled'],
    ]);
  });

  it('sponsorHostsSeen returns labels this sponsor polled within 10 minutes; a team-wide poll keeps it', () => {
    const { db, team, dana, eve } = teamWithHumans();
    const now = Date.now();
    recordHostSeen(db, team.id, 'h1', now, dana.id);
    recordHostSeen(db, team.id, 'h1', now + 1, null);
    recordHostSeen(db, team.id, 'old', now - 11 * 60_000, dana.id);
    recordHostSeen(db, team.id, 'h2', now, eve.id);
    expect(sponsorHostsSeen(db, team.id, dana.id, now + 1)).toEqual(['h1']);
  });

  it('takeProvisionedWake yields a ready row once', () => {
    const { db, team, dana, scopeOf } = teamWithHumans();
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    const row = insertProvision(db, team.id, agent.id, dana.id);
    expect(takeProvisionedWake(db, team.id, agent.id)).toBeUndefined();
    claimProvisions(db, team.id, 'h1', scopeOf(dana.id), 5);
    reportProvision(db, team.id, row.id, 'h1', { state: 'ready' });
    expect(takeProvisionedWake(db, team.id, agent.id)?.id).toBe(row.id);
    expect(takeProvisionedWake(db, team.id, agent.id)).toBeUndefined();
  });
});
