import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { issueGrant } from './grants.js';
import { addMember, getMemberById } from './members.js';
import { enrollResidency, getResidency } from './residency.js';
import { createSponsoredAgent } from './sponsoredAgents.js';
import { revokeExpiredMember, revokeSponsoredDescendants } from './sponsoredCascade.js';
import { createTeam } from './teams.js';

/** ADR 463 §4.2: losing standing takes every way a descendant could still run. */
describe('revokeSponsoredDescendants', () => {
  function hostedAgent() {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'acme' });
    const { row: dana } = addMember(db, team, { name: 'dana', kind: 'human' });
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    const mint = issueGrant(
      db,
      team.id,
      { scope: 'seat', target: 'scout', lifetime: 'standing', single_use: false },
      'dana',
    );
    enrollResidency(db, team.id, {
      member_id: agent.id,
      harness: 'claude-code',
      host: 'dana-mbp',
      grant_id: mint.grant.id,
      authorized_by: 'dana',
    });
    return { db, team, dana, agent, grantId: mint.grant.id };
  }

  it('disables the agent, revokes its residency and standing grant, and audits the trigger', () => {
    const { db, team, dana, agent, grantId } = hostedAgent();
    const out = revokeSponsoredDescendants(db, team.id, dana, 'remove', null);
    expect(out.map((r) => [r.member.name, r.residency_host])).toEqual([['scout', 'dana-mbp']]);
    expect(getMemberById(db, agent.id)!.account_status).toBe('disabled');
    expect(getResidency(db, team.id, agent.id)).toBeNull();
    const grant = db.prepare('SELECT revoked FROM grants WHERE id = ?').get(grantId) as {
      revoked: number;
    };
    expect(grant.revoked).toBe(1);
    const audit = db
      .prepare("SELECT detail FROM audit WHERE action = 'member.revoked_cascade'")
      .get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({
      root: 'dana',
      trigger: 'remove',
      residency_host: 'dana-mbp',
    });
  });

  it('reaches grand-descendants', () => {
    const { db, team, dana, agent } = hostedAgent();
    db.prepare(
      "INSERT INTO members (id, team_id, name, kind, role, sponsored_by, created_at, updated_at) VALUES ('g1', ?, 'grand', 'agent', '', ?, 0, 0)",
    ).run(team.id, agent.id);
    const names = revokeSponsoredDescendants(db, team.id, dana, 'remove', null).map(
      (r) => r.member.name,
    );
    expect(names).toEqual(['scout', 'grand']);
  });
});

describe('revokeExpiredMember (ADR 463 §4.4)', () => {
  it('unhosts the expired agent itself and cascades from an expired sponsor', () => {
    const db = openDb(':memory:');
    const team = createTeam(db, { slug: 'acme' });
    const { row: dana } = addMember(db, team, { name: 'dana', kind: 'human' });
    const { member: agent } = createSponsoredAgent(db, team, dana, { name: 'scout' });
    enrollResidency(db, team.id, {
      member_id: agent.id,
      harness: 'claude-code',
      host: 'dana-mbp',
      grant_id: null,
      authorized_by: 'dana',
    });
    expect(revokeExpiredMember(db, team.id, agent)).toEqual([]);
    expect(getResidency(db, team.id, agent.id)).toBeNull();

    const { member: second } = createSponsoredAgent(db, team, dana, { name: 'scout-2' });
    enrollResidency(db, team.id, {
      member_id: second.id,
      harness: 'claude-code',
      host: 'dana-mbp',
      grant_id: null,
      authorized_by: 'dana',
    });
    const out = revokeExpiredMember(db, team.id, dana);
    expect(out.map((r) => r.member.name)).toContain('scout-2');
    expect(getResidency(db, team.id, second.id)).toBeNull();
  });
});
