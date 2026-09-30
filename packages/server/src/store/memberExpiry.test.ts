import { describe, expect, it } from 'vitest';
import { openTestDb } from '../db/testing.js';
import {
  addMember,
  authMember,
  cascadeSponsoredRevocation,
  mintAgentSeatCredential,
  mintCredential,
} from './members.js';
import { mintTokenPair, registerClient } from './oauth.js';
import { resolveAccountStatus } from './rows.js';
import { createTeam } from './teams.js';

/**
 * ADR 449 increment 1 — the two enforcement halves that need no server: a member whose `until`
 * lifecycle has passed is refused on every credential kind, and revoking a sponsor takes their
 * sponsored members (transitively) with them. The member-created-agent surface is increment 2.
 */

const HOUR = 60 * 60 * 1000;

async function teamWithExpiringHuman(until: number) {
  const db = openTestDb(':memory:');
  const team = await createTeam(db, { slug: 'acme' });
  const { row } = await addMember(db, team, {
    name: 'guest',
    kind: 'human',
    lifecycle: 'until',
    lifecycleUntil: until,
  });
  const { credential } = await mintCredential(db, row.id);
  return { db, team, row, credential };
}

describe('lifecycle_until is enforced at auth (ADR 449 §2)', async () => {
  it('refuses an expired human on their mscr_ credential', async () => {
    const { db, credential } = await teamWithExpiringHuman(Date.now() - HOUR);
    await expect(authMember(db, 'acme', credential)).rejects.toThrowError(/membership expired/);
  });

  it('admits the same member before their expiry', async () => {
    const { db, credential } = await teamWithExpiringHuman(Date.now() + HOUR);
    expect((await authMember(db, 'acme', credential)).member.name).toBe('guest');
  });

  it('refuses an expired human on an OAuth msat_ bearer (ADR 446 remote MCP)', async () => {
    const { db, team, row } = await teamWithExpiringHuman(Date.now() + HOUR);
    const { client_id } = await registerClient(db, {
      teamId: team.id,
      clientName: 'phone',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    const { access_token } = await mintTokenPair(db, {
      teamId: team.id,
      memberId: row.id,
      clientId: client_id,
    });
    expect((await authMember(db, 'acme', access_token)).member.name).toBe('guest');
    // The end moves into the past after the mint (an admin shortened it): the token's own expiry
    // no longer protects anything — auth reads the member's clock at use.
    db.prepare('UPDATE members SET lifecycle_until = ? WHERE id = ?').run(Date.now() - 1, row.id);
    await expect(authMember(db, 'acme', access_token)).rejects.toThrowError(/membership expired/);
  });

  it('refuses an expired agent on its msac_ credential too', async () => {
    const db = openTestDb(':memory:');
    const team = await createTeam(db, { slug: 'acme' });
    const { row } = await addMember(db, team, {
      name: 'helper',
      kind: 'agent',
      lifecycle: 'until',
      lifecycleUntil: Date.now() - HOUR,
    });
    const { seat_credential } = await mintAgentSeatCredential(db, row.id);
    await expect(
      authMember(db, 'acme', seat_credential, undefined, undefined, { leaseless: true }),
    ).rejects.toThrowError(/membership expired/);
  });

  it('leaves lifecycle "forever" members untouched (revive-shaped teams)', async () => {
    const db = openTestDb(':memory:');
    const team = await createTeam(db, { slug: 'rev' });
    const { row } = await addMember(db, team, { name: 'stanley', kind: 'human' });
    const { credential } = await mintCredential(db, row.id);
    expect((await authMember(db, 'rev', credential)).member.name).toBe('stanley');
  });
});

describe('sponsorship + cascading revocation (ADR 449 §3)', async () => {
  it('addMember records sponsored_by', async () => {
    const db = openTestDb(':memory:');
    const team = await createTeam(db, { slug: 'acme' });
    const { row: human } = await addMember(db, team, { name: 'guest', kind: 'human' });
    const { row: agent } = await addMember(db, team, {
      name: 'guest-scout',
      kind: 'agent',
      sponsoredBy: human.id,
    });
    expect(agent.sponsored_by).toBe(human.id);
  });

  it('revoking a sponsor disables their sponsored members, transitively, and reports each one', async () => {
    const db = openTestDb(':memory:');
    const team = await createTeam(db, { slug: 'acme' });
    const { row: human } = await addMember(db, team, { name: 'guest', kind: 'human' });
    const { row: a1 } = await addMember(db, team, {
      name: 'scout',
      kind: 'agent',
      sponsoredBy: human.id,
    });
    const { row: a2 } = await addMember(db, team, {
      name: 'digger',
      kind: 'agent',
      sponsoredBy: a1.id,
    });
    const { row: other } = await addMember(db, team, { name: 'bystander', kind: 'agent' });

    const affected = await cascadeSponsoredRevocation(db, team.id, human.id);
    expect(affected.map((m) => m.name).sort()).toEqual(['digger', 'scout']);
    for (const id of [a1.id, a2.id]) {
      const row = db
        .prepare<
          [string],
          { account_status: string | null }
        >('SELECT account_status FROM members WHERE id = ?')
        .get(id)!;
      expect(row.account_status).toBe('disabled');
    }
    const untouched = db
      .prepare<
        [string],
        { account_status: string | null }
      >('SELECT account_status FROM members WHERE id = ?')
      .get(other.id)!;
    expect(untouched.account_status).toBeNull();
  });

  it('a disabled sponsored member is refused at auth', async () => {
    const db = openTestDb(':memory:');
    const team = await createTeam(db, { slug: 'acme' });
    const { row: human } = await addMember(db, team, { name: 'guest', kind: 'human' });
    const { row: agent } = await addMember(db, team, {
      name: 'scout',
      kind: 'agent',
      sponsoredBy: human.id,
    });
    const { seat_credential } = await mintAgentSeatCredential(db, agent.id);
    await cascadeSponsoredRevocation(db, team.id, human.id);
    expect(
      resolveAccountStatus(db.prepare('SELECT * FROM members WHERE id = ?').get(agent.id) as never),
    ).toBe('disabled');
    await expect(
      authMember(db, 'acme', seat_credential, undefined, undefined, { leaseless: true }),
    ).rejects.toThrowError(/disabled/);
  });
});
