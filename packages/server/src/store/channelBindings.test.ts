import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import { issueAskChannelToken } from './askChannelTokens.js';
import { listAudit } from './audit.js';
import {
  channelBindingStanding,
  confirmPairing,
  killSwitchChannels,
  listBindings,
  listPendingPairings,
  recordPairingIdentity,
  rejectPairing,
  revokeBinding,
  startPairing,
} from './channelBindings.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

let openStore: () => Promise<Driver>;

async function seed() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
  const ada = (await addMember(db, team, { name: 'ada', kind: 'human' })).row;
  return { db, team, nick, ada };
}

async function paired(db: Driver, teamId: string, memberId: string, actor = 'nick') {
  const { pairing, nonce } = await startPairing(db, {
    teamId,
    memberId,
    actor,
    channel: 'slack',
    now: NOW,
  });
  await recordPairingIdentity(db, {
    nonce,
    providerTenantId: 'T1',
    providerUserId: 'U1',
    now: NOW + 1_000,
  });
  const confirmed = await confirmPairing(db, {
    teamId,
    memberId,
    actor,
    pairingId: pairing.id,
    now: NOW + 2_000,
  });
  if (!confirmed.ok) throw new Error(confirmed.reason);
  return confirmed.binding;
}

withDrivers('channel bindings (ADR 618 §7)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('a pairing binds only after the original-surface confirmation, at generation 1', async () => {
    const { db, team, nick } = await seed();
    const { pairing, nonce } = await startPairing(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      channel: 'slack',
      now: NOW,
    });
    // The relay-side identity arriving binds nothing yet.
    expect(
      await recordPairingIdentity(db, {
        nonce,
        providerTenantId: 'T1',
        providerUserId: 'U1',
        now: NOW + 1_000,
      }),
    ).toMatchObject({ ok: true });
    expect(await listBindings(db, team.id, nick.id)).toEqual([]);
    const pending = await listPendingPairings(db, team.id, nick.id, NOW + 1_000);
    expect(pending).toHaveLength(1);
    // The confirmation surface reads the daemon-held identity, not a relay copy.
    expect(pending[0]).toMatchObject({ provider_tenant_id: 'T1', provider_user_id: 'U1' });

    const confirmed = await confirmPairing(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      pairingId: pairing.id,
      now: NOW + 2_000,
    });
    expect(confirmed).toMatchObject({
      ok: true,
      binding: { generation: 1, status: 'active', provider_tenant_id: 'T1' },
    });
    // The nonce is spent: a second confirmation is refused.
    expect(
      await confirmPairing(db, {
        teamId: team.id,
        memberId: nick.id,
        actor: 'nick',
        pairingId: pairing.id,
        now: NOW + 3_000,
      }),
    ).toEqual({ ok: false, reason: 'not_awaiting_confirmation' });
  });

  it('a different member cannot confirm, reject, or revoke what nick paired', async () => {
    const { db, team, nick, ada } = await seed();
    const { pairing, nonce } = await startPairing(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      channel: 'slack',
      now: NOW,
    });
    await recordPairingIdentity(db, {
      nonce,
      providerTenantId: 'T1',
      providerUserId: 'U1',
      now: NOW + 1_000,
    });
    expect(
      await confirmPairing(db, {
        teamId: team.id,
        memberId: ada.id,
        actor: 'ada',
        pairingId: pairing.id,
        now: NOW + 2_000,
      }),
    ).toEqual({ ok: false, reason: 'not_owner' });
    expect(
      await rejectPairing(db, {
        teamId: team.id,
        memberId: ada.id,
        actor: 'ada',
        pairingId: pairing.id,
        now: NOW + 2_000,
      }),
    ).toEqual({ ok: false, reason: 'not_owner' });
    const binding = await paired(db, team.id, nick.id);
    expect(
      await revokeBinding(db, {
        teamId: team.id,
        memberId: ada.id,
        actor: 'ada',
        bindingId: binding.id,
        now: NOW + 3_000,
      }),
    ).toEqual({ ok: false, reason: 'not_owner' });
  });

  it('an unknown, expired, or replayed nonce stages nothing', async () => {
    const { db, team, nick } = await seed();
    expect(
      await recordPairingIdentity(db, {
        nonce: 'nope',
        providerTenantId: 'T1',
        providerUserId: 'U1',
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: 'unknown_nonce' });
    const { nonce } = await startPairing(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      channel: 'slack',
      now: NOW,
    });
    expect(
      await recordPairingIdentity(db, {
        nonce,
        providerTenantId: 'T1',
        providerUserId: 'U1',
        now: NOW + 6 * MINUTE,
      }),
    ).toEqual({ ok: false, reason: 'expired' });
    const again = await startPairing(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      channel: 'slack',
      now: NOW,
    });
    await recordPairingIdentity(db, {
      nonce: again.nonce,
      providerTenantId: 'T1',
      providerUserId: 'U1',
      now: NOW + 1_000,
    });
    // A replay against the staged nonce is an attempt, not a second staging.
    expect(
      await recordPairingIdentity(db, {
        nonce: again.nonce,
        providerTenantId: 'T9',
        providerUserId: 'U9',
        now: NOW + 2_000,
      }),
    ).toEqual({ ok: false, reason: 'not_awaiting_identity' });
    const pending = await listPendingPairings(db, team.id, nick.id, NOW + 2_000);
    expect(pending[0]).toMatchObject({ provider_tenant_id: 'T1', attempts: 1 });
  });

  it('revoke kills the generation and consumes its outstanding tokens; re-pair mints generation 2', async () => {
    const { db, team, nick } = await seed();
    const binding = await paired(db, team.id, nick.id);
    await issueAskChannelToken(db, {
      teamId: team.id,
      askId: 'ask-1',
      askDigest: 'd1',
      actionClass: 'advisory',
      channel: 'slack',
      bindingId: binding.id,
      bindingGeneration: 1,
      requiredAssurance: 'A1',
      expiresAt: NOW + 5 * MINUTE,
      now: NOW,
    });
    expect(await channelBindingStanding(db, team.id, binding.id, 1)).toBe('current');
    const revoked = await revokeBinding(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      bindingId: binding.id,
      now: NOW + 3_000,
    });
    expect(revoked).toEqual({ ok: true, tokensRevoked: 1 });
    expect(await channelBindingStanding(db, team.id, binding.id, 1)).toBe('stale');
    const rows = await db.all<{ consumed_at: number | null }>(
      'SELECT consumed_at FROM ask_channel_tokens',
    );
    expect(rows[0]!.consumed_at).toBe(NOW + 3_000);

    const rebound = await paired(db, team.id, nick.id);
    expect(rebound.generation).toBe(2);
    expect(await channelBindingStanding(db, team.id, rebound.id, 1)).toBe('stale');
    expect(await channelBindingStanding(db, team.id, rebound.id, 2)).toBe('current');
  });

  it('the kill switch revokes every binding and outstanding token, audited without the relay', async () => {
    const { db, team, nick } = await seed();
    const a = await paired(db, team.id, nick.id);
    const { pairing, nonce } = await startPairing(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      channel: 'discord',
      now: NOW,
    });
    await recordPairingIdentity(db, {
      nonce,
      providerTenantId: 'D1',
      providerUserId: 'U2',
      now: NOW + 1_000,
    });
    const b = (
      await confirmPairing(db, {
        teamId: team.id,
        memberId: nick.id,
        actor: 'nick',
        pairingId: pairing.id,
        now: NOW + 2_000,
      })
    ).ok
      ? await listBindings(db, team.id, nick.id)
      : [];
    expect(b).toHaveLength(2);
    for (const [i, binding] of [a, b.find((x) => x.id !== a.id)!].entries()) {
      await issueAskChannelToken(db, {
        teamId: team.id,
        askId: `ask-${i}`,
        askDigest: 'd1',
        actionClass: 'advisory',
        channel: binding.channel,
        bindingId: binding.id,
        bindingGeneration: binding.generation,
        requiredAssurance: 'A1',
        expiresAt: NOW + 5 * MINUTE,
        now: NOW,
      });
    }
    const result = await killSwitchChannels(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      now: NOW + 4_000,
    });
    expect(result).toEqual({ bindingsRevoked: 2, tokensRevoked: 2 });
    expect(await channelBindingStanding(db, team.id, a.id, 1)).toBe('stale');
    const audit = (await listAudit(db, team.id)).filter((r) => r.action === 'channel.killswitch');
    expect(audit).toHaveLength(1);
    expect(JSON.parse(audit[0]!.detail!)).toMatchObject({
      bindings_revoked: 2,
      tokens_revoked: 2,
    });
  });

  it('no audit row carries a raw nonce', async () => {
    const { db, team, nick } = await seed();
    const { nonce } = await startPairing(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
      channel: 'slack',
      now: NOW,
    });
    await recordPairingIdentity(db, {
      nonce,
      providerTenantId: 'T1',
      providerUserId: 'U1',
      now: NOW + 1_000,
    });
    const blob = JSON.stringify(await listAudit(db, team.id));
    expect(blob).not.toContain(nonce);
    expect(blob).toContain('channel.pair.proposed');
  });

  describe('rejection', () => {
    it('a rejected pairing binds nothing and spends the nonce', async () => {
      const { db, team, nick } = await seed();
      const { pairing, nonce } = await startPairing(db, {
        teamId: team.id,
        memberId: nick.id,
        actor: 'nick',
        channel: 'slack',
        now: NOW,
      });
      await recordPairingIdentity(db, {
        nonce,
        providerTenantId: 'T1',
        providerUserId: 'U1',
        now: NOW + 1_000,
      });
      expect(
        await rejectPairing(db, {
          teamId: team.id,
          memberId: nick.id,
          actor: 'nick',
          pairingId: pairing.id,
          now: NOW + 2_000,
        }),
      ).toEqual({ ok: true });
      expect(await listBindings(db, team.id, nick.id)).toEqual([]);
    });
  });
});
