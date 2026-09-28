import { GENERALIST_CAPABILITIES } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { openDb } from '../db/open.js';
import { addMember, getMemberByName, leaveMember } from './members.js';
import { enrollResidency } from './residency.js';
import {
  CONNECT_NONCE_TTL_MS,
  SPONSORED_AGENT_CAP,
  connectRefusal,
  createSponsoredAgent,
  issueAgentConnectNonce,
  mintConnectNonce,
  redeemAgentConnectNonce,
} from './sponsoredAgents.js';
import { createTeam } from './teams.js';

/**
 * ADR 449 §3–4, increment 2a — the store half of member-created agents: a human mints an agent
 * seat that records them as sponsor, can never outlive them, is capped per sponsor, and is reached
 * through a one-time connect nonce (hashed at rest, single-use, 15 minutes). Redemption at OAuth
 * authorize is increment 2b; the store's redeem is exercised here so 2b wires a tested primitive.
 */

const HOUR = 60 * 60 * 1000;

function teamWithHuman(opts: { until?: number } = {}) {
  const db = openDb(':memory:');
  const team = createTeam(db, { slug: 'acme' });
  const { row: human } = addMember(db, team, {
    name: 'dana',
    kind: 'human',
    ...(opts.until !== undefined
      ? { lifecycle: 'until' as const, lifecycleUntil: opts.until }
      : {}),
  });
  return { db, team, human };
}

describe('createSponsoredAgent (ADR 449 §3)', () => {
  it('mints an agent-kind member sponsored by the caller, with a connect nonce', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce, expires_at } = createSponsoredAgent(db, team, human, {
      name: 'dana-scout',
      role: 'research',
    });
    expect(member.kind).toBe('agent');
    expect(member.sponsored_by).toBe(human.id);
    expect(member.role).toBe('research');
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/); // randomBytes(32), base64url
    expect(expires_at - Date.now()).toBeLessThanOrEqual(CONNECT_NONCE_TTL_MS);
  });

  it('stores only the nonce hash', () => {
    const { db, team, human } = teamWithHuman();
    const { nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    const rows = db.prepare('SELECT * FROM agent_connect_nonces').all() as Record<
      string,
      unknown
    >[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(nonce);
  });

  it('an unexpiring sponsor mints an unexpiring agent', () => {
    const { db, team, human } = teamWithHuman();
    const { member } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(member.lifecycle).not.toBe('until');
    expect(member.lifecycle_until).toBeNull();
  });

  it("an expiring sponsor's agent inherits the sponsor's end — it cannot outlive them", () => {
    const until = Date.now() + 2 * HOUR;
    const { db, team, human } = teamWithHuman({ until });
    const { member } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(member.lifecycle).toBe('until');
    expect(member.lifecycle_until).toBe(until);
  });

  it('refuses an agent caller — only human members sponsor', () => {
    const { db, team } = teamWithHuman();
    const { row: agent } = addMember(db, team, { name: 'bot', kind: 'agent' });
    expect(() => createSponsoredAgent(db, team, agent, { name: 'bot-child' })).toThrowError(
      /only a human member/,
    );
  });

  it(`refuses the ${SPONSORED_AGENT_CAP + 1}th live agent, naming the cap`, () => {
    const { db, team, human } = teamWithHuman();
    for (let i = 0; i < SPONSORED_AGENT_CAP; i++)
      createSponsoredAgent(db, team, human, { name: `a${i}` });
    expect(() => createSponsoredAgent(db, team, human, { name: 'one-too-many' })).toThrowError(
      new RegExp(`cap of ${SPONSORED_AGENT_CAP}`),
    );
  });

  it('a removed agent frees its slot under the cap', () => {
    const { db, team, human } = teamWithHuman();
    const made = [];
    for (let i = 0; i < SPONSORED_AGENT_CAP; i++)
      made.push(createSponsoredAgent(db, team, human, { name: `a${i}` }).member);
    leaveMember(db, made[0]!.id);
    expect(createSponsoredAgent(db, team, human, { name: 'replacement' }).member.name).toBe(
      'replacement',
    );
  });

  it('refuses a live name', () => {
    const { db, team, human } = teamWithHuman();
    expect(() => createSponsoredAgent(db, team, human, { name: 'dana' })).toThrowError(
      /already exists/,
    );
  });

  it("refuses a removed member's name — a sponsored mint never revives someone else's history", () => {
    const { db, team, human } = teamWithHuman();
    const { row: old } = addMember(db, team, { name: 'ghost-of-old', kind: 'agent' });
    leaveMember(db, old.id);
    expect(() => createSponsoredAgent(db, team, human, { name: 'ghost-of-old' })).toThrowError(
      /was used by a removed member/,
    );
    expect(getMemberByName(db, team.id, 'ghost-of-old')!.left_at).not.toBeNull();
  });
});

describe('agent mint hardening (ADR 459)', () => {
  it('a sponsor narrowed off can_create_agents is refused while a teammate mints', () => {
    const { db, team, human } = teamWithHuman();
    const { row: mate } = addMember(db, team, { name: 'mate', kind: 'human' });
    db.prepare('UPDATE members SET capabilities = ? WHERE id = ?').run(
      JSON.stringify({ ...GENERALIST_CAPABILITIES, can_create_agents: false }),
      human.id,
    );
    const narrowed = getMemberByName(db, team.id, 'dana')!;
    expect(() => createSponsoredAgent(db, team, narrowed, { name: 'dana-scout' })).toThrowError(
      /can_create_agents/,
    );
    // The teammate's grant is untouched.
    expect(createSponsoredAgent(db, team, mate, { name: 'mate-scout' }).member.name).toBe(
      'mate-scout',
    );
  });

  it('the per-team cap tunes the count and names the effective number', () => {
    const { db, team, human } = teamWithHuman();
    for (let i = 0; i < 6; i++)
      createSponsoredAgent(db, team, human, { name: `a${i}` }, Date.now(), { cap: 6 });
    expect(() =>
      createSponsoredAgent(db, team, human, { name: 'one-too-many' }, Date.now(), { cap: 6 }),
    ).toThrowError(/cap of 6/);
  });
});

describe('agent connect nonce (ADR 449 §4)', () => {
  it('redeems once, for the agent it was minted for, on its own team', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(redeemAgentConnectNonce(db, team.id, nonce)?.agent.id).toBe(member.id);
    expect(redeemAgentConnectNonce(db, team.id, nonce)).toBeNull();
  });

  it('a wrong-team attempt neither redeems nor burns it', () => {
    const { db, team, human } = teamWithHuman();
    const other = createTeam(db, { slug: 'other' });
    const { member, nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(redeemAgentConnectNonce(db, other.id, nonce)).toBeNull();
    expect(redeemAgentConnectNonce(db, team.id, nonce)?.agent.id).toBe(member.id);
  });

  it('is void past its TTL', () => {
    const { db, team, human } = teamWithHuman();
    const { nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    expect(redeemAgentConnectNonce(db, team.id, nonce, Date.now() + CONNECT_NONCE_TTL_MS + 1)).toBe(
      null,
    );
  });

  it('re-issuing burns the previous nonce — one live link per agent', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce: first } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    const { nonce: second } = issueAgentConnectNonce(db, team.id, member.id, human.id);
    expect(redeemAgentConnectNonce(db, team.id, first)).toBeNull();
    expect(redeemAgentConnectNonce(db, team.id, second)?.agent.id).toBe(member.id);
  });

  it('refuses to redeem for an agent that has since been removed or disabled', () => {
    const { db, team, human } = teamWithHuman();
    const { member, nonce } = createSponsoredAgent(db, team, human, { name: 'dana-scout' });
    leaveMember(db, member.id);
    expect(redeemAgentConnectNonce(db, team.id, nonce)).toBeNull();
  });
});

describe('mintConnectNonce', () => {
  it('redraws a nonce that would begin with a credential prefix', () => {
    const unlucky = Buffer.from('mscr_' + 'A'.repeat(38), 'base64url');
    const lucky = Buffer.alloc(32, 7);
    const draws = [unlucky, lucky];
    const nonce = mintConnectNonce(() => draws.shift()!);
    expect(nonce).toBe(lucky.toString('base64url'));
    expect(unlucky.toString('base64url').startsWith('mscr_')).toBe(true);
  });
});

describe('who may connect a sponsored agent (ADR 456 §2–3)', () => {
  function teamOfThree() {
    const { db, team, human: sponsor } = teamWithHuman();
    const { row: mate } = addMember(db, team, { name: 'mate', kind: 'human' });
    const { row: boss } = addMember(db, team, { name: 'boss', kind: 'human' });
    db.prepare('UPDATE members SET capabilities = ? WHERE id = ?').run(
      JSON.stringify({ ...GENERALIST_CAPABILITIES, is_admin: true }),
      boss.id,
    );
    const admin = getMemberByName(db, team.id, 'boss')!;
    const { member: agent } = createSponsoredAgent(db, team, sponsor, { name: 'scout' });
    return { db, team, sponsor, mate, admin, agent };
  }

  it("'sponsor': the sponsor and an admin may, a teammate may not", () => {
    const { team, sponsor, mate, admin, agent } = teamOfThree();
    expect(connectRefusal(sponsor, agent, 'sponsor', team.slug)).toBeNull();
    expect(connectRefusal(admin, agent, 'sponsor', team.slug)).toBeNull();
    expect(connectRefusal(mate, agent, 'sponsor', team.slug)?.message).toMatch(
      /only an agent's sponsor or an admin/,
    );
  });

  it("'any_member': any human member may", () => {
    const { team, mate, agent } = teamOfThree();
    expect(connectRefusal(mate, agent, 'any_member', team.slug)).toBeNull();
  });

  it('an agent never issues, under either policy', () => {
    const { team, agent } = teamOfThree();
    for (const policy of ['sponsor', 'any_member'] as const)
      expect(connectRefusal(agent, agent, policy, team.slug)?.message).toMatch(/only a human/);
  });

  it('only a live member-created agent is connectable', () => {
    const { db, team, mate } = teamOfThree();
    const { row: seated } = addMember(db, team, { name: 'seated', kind: 'agent' });
    expect(connectRefusal(mate, seated, 'any_member', team.slug)?.code).toBe('not_found');
    expect(connectRefusal(mate, undefined, 'any_member', team.slug)?.code).toBe('not_found');
  });

  it('redeem returns the issuer, and refuses once the issuer has lost standing', () => {
    const { db, team, mate, agent } = teamOfThree();
    const { nonce } = issueAgentConnectNonce(db, team.id, agent.id, mate.id);
    const got = redeemAgentConnectNonce(db, team.id, nonce);
    expect(got?.agent.id).toBe(agent.id);
    expect(got?.issuedBy.name).toBe('mate');

    const { nonce: second } = issueAgentConnectNonce(db, team.id, agent.id, mate.id);
    leaveMember(db, mate.id);
    expect(redeemAgentConnectNonce(db, team.id, second)).toBeNull();
  });
});

describe('a hosted agent is never OAuth-connectable (ADR 463 §4.1)', () => {
  function hosted() {
    const { db, team, human } = teamWithHuman();
    const { member: agent, nonce } = createSponsoredAgent(db, team, human, { name: 'scout' });
    enrollResidency(db, team.id, {
      member_id: agent.id,
      harness: 'claude-code',
      host: 'dana-mbp',
      grant_id: null,
      authorized_by: 'dana',
    });
    return { db, team, human, agent, nonce };
  }

  it('refuses a connect link for an enrolled agent even for its sponsor, under either policy', () => {
    const { team, human, agent } = hosted();
    for (const policy of ['sponsor', 'any_member'] as const) {
      const err = connectRefusal(human, agent, policy, team.slug, { hosted: 'dana-mbp' });
      expect(err?.code).toBe('conflict');
      expect(err?.message).toMatch(/hosted on dana-mbp/);
    }
  });

  it('an unhosted agent connects as before', () => {
    const { db, team, human } = teamWithHuman();
    const { member: agent } = createSponsoredAgent(db, team, human, { name: 'scout' });
    expect(connectRefusal(human, agent, 'sponsor', team.slug, { hosted: null })).toBeNull();
  });

  it('a link issued before the agent was hosted redeems nothing once it is', () => {
    const { db, team, nonce } = hosted();
    expect(redeemAgentConnectNonce(db, team.id, nonce)).toBeNull();
  });
});
