import { createHash, randomBytes, randomInt } from 'node:crypto';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import type { BindingStanding } from './askChannelTokens.js';
import { appendAudit } from './audit.js';

/**
 * The binding store (ADR 618 §7, spec §Pairing): a binding links an immutable provider identity
 * (tenant id + user id, never email or display name) to a human Member, and it lives in the
 * daemon. The relay cannot create, change or complete one: it can only carry a provider identity
 * to `recordPairingIdentity`, and nothing is bound until the human confirms on the original
 * authenticated surface, which shows the tenant and user **as stored here** — a relay that lies
 * about who paired is lying into a confirmation that reads this table, not its payload.
 *
 * A pairing nonce is single-use, five minutes, scoped to the member, the team and the channel,
 * with strict attempt limits; only its sha256 is stored (hard rule 5). The two-digit check code
 * is a UX check only (about 6.6 bits) and is never the authorization secret. Binding, revoking
 * and the kill switch are audited (ADR 618 §8); a raw nonce is never audited or logged.
 */

export const PAIRING_NONCE_TTL_MS = 5 * 60_000;
export const PAIRING_MAX_ATTEMPTS = 5;

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export interface ChannelBinding {
  id: string;
  team_id: string;
  member_id: string;
  channel: string;
  provider_tenant_id: string;
  provider_user_id: string;
  generation: number;
  status: 'active' | 'revoked';
  created_at: number;
  revoked_at: number | null;
}

export interface Pairing {
  id: string;
  team_id: string;
  member_id: string;
  channel: string;
  check_code: string;
  state: 'awaiting_identity' | 'awaiting_confirmation' | 'confirmed' | 'rejected';
  provider_tenant_id: string | null;
  provider_user_id: string | null;
  attempts: number;
  expires_at: number;
  created_at: number;
  consumed_at: number | null;
}

export type PairingRefusal =
  | 'unknown_nonce'
  | 'expired'
  | 'consumed'
  | 'too_many_attempts'
  | 'not_awaiting_identity'
  | 'not_found'
  | 'not_owner'
  | 'not_awaiting_confirmation';

/**
 * Start a pairing (spec §Pairing step 1): mint the nonce for an authenticated human on the
 * original surface. The plaintext nonce is returned once, to be carried by the provider flow;
 * the row keeps only its hash.
 */
export async function startPairing(
  db: Driver,
  input: { teamId: string; memberId: string; actor: string; channel: string; now?: number },
): Promise<{ pairing: Pairing; nonce: string }> {
  const now = input.now ?? Date.now();
  const nonce = randomBytes(32).toString('base64url');
  const pairing: Pairing = {
    id: ulid(now),
    team_id: input.teamId,
    member_id: input.memberId,
    channel: input.channel,
    check_code: String(randomInt(0, 100)).padStart(2, '0'),
    state: 'awaiting_identity',
    provider_tenant_id: null,
    provider_user_id: null,
    attempts: 0,
    expires_at: now + PAIRING_NONCE_TTL_MS,
    created_at: now,
    consumed_at: null,
  };
  await db.tx(async (t) => {
    await t.run(
      `INSERT INTO pairing_nonces
         (id, nonce_hash, team_id, member_id, channel, check_code, state, provider_tenant_id,
          provider_user_id, attempts, expires_at, created_at, consumed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?, ?, NULL)`,
      [
        pairing.id,
        sha256(nonce),
        pairing.team_id,
        pairing.member_id,
        pairing.channel,
        pairing.check_code,
        pairing.state,
        pairing.expires_at,
        pairing.created_at,
      ],
    );
    await appendAudit(t, input.teamId, {
      actor: input.actor,
      action: 'channel.pair.proposed',
      target: pairing.id,
      result: 'allow',
      detail: { channel: input.channel, expires_at: pairing.expires_at },
    });
  });
  return { pairing, nonce };
}

/**
 * The provider identity arrives (spec §Pairing step 3): record it **daemon-side** against the
 * nonce. This binds nothing — it only stages the exact tenant and user the confirmation surface
 * will show. Each presentation against a spent or already-staged nonce counts as an attempt;
 * past the limit the nonce is consumed and the pairing is dead.
 */
export async function recordPairingIdentity(
  db: Driver,
  input: {
    nonce: string;
    providerTenantId: string;
    providerUserId: string;
    now?: number;
  },
): Promise<{ ok: true; pairing: Pairing } | { ok: false; reason: PairingRefusal }> {
  const now = input.now ?? Date.now();
  return db.tx(async (t) => {
    const row = await t.get<Pairing & { nonce_hash: string }>(
      'SELECT * FROM pairing_nonces WHERE nonce_hash = ?',
      [sha256(input.nonce)],
    );
    if (!row) return { ok: false as const, reason: 'unknown_nonce' as const };
    if (row.consumed_at !== null) return { ok: false as const, reason: 'consumed' as const };
    if (now >= row.expires_at) {
      await t.run('UPDATE pairing_nonces SET consumed_at = ? WHERE id = ?', [now, row.id]);
      return { ok: false as const, reason: 'expired' as const };
    }
    if (row.state !== 'awaiting_identity') {
      const attempts = row.attempts + 1;
      await t.run('UPDATE pairing_nonces SET attempts = ?, consumed_at = ? WHERE id = ?', [
        attempts,
        attempts >= PAIRING_MAX_ATTEMPTS ? now : null,
        row.id,
      ]);
      return {
        ok: false as const,
        reason: (attempts >= PAIRING_MAX_ATTEMPTS
          ? 'too_many_attempts'
          : 'not_awaiting_identity') as PairingRefusal,
      };
    }
    await t.run(
      `UPDATE pairing_nonces SET state = 'awaiting_confirmation', provider_tenant_id = ?,
         provider_user_id = ? WHERE id = ?`,
      [input.providerTenantId, input.providerUserId, row.id],
    );
    const pairing = await t.get<Pairing>('SELECT * FROM pairing_nonces WHERE id = ?', [row.id]);
    return { ok: true as const, pairing: pairing! };
  });
}

/** One pairing as the daemon holds it — what the confirmation surface renders (never a relay copy). */
export async function getPairing(
  db: Driver,
  teamId: string,
  pairingId: string,
): Promise<Pairing | null> {
  return (
    (await db.get<Pairing>('SELECT * FROM pairing_nonces WHERE id = ? AND team_id = ?', [
      pairingId,
      teamId,
    ])) ?? null
  );
}

/** Pairings a member can still confirm or reject (identity staged, nonce unspent, unexpired). */
export async function listPendingPairings(
  db: Driver,
  teamId: string,
  memberId: string,
  now: number = Date.now(),
): Promise<Pairing[]> {
  return db.all<Pairing>(
    `SELECT * FROM pairing_nonces
      WHERE team_id = ? AND member_id = ? AND state = 'awaiting_confirmation'
        AND consumed_at IS NULL AND expires_at > ?
      ORDER BY created_at`,
    [teamId, memberId, now],
  );
}

async function loadOwnedPairing(
  t: Driver,
  teamId: string,
  memberId: string,
  pairingId: string,
): Promise<{ pairing: Pairing } | { reason: PairingRefusal }> {
  const pairing = await t.get<Pairing>(
    'SELECT * FROM pairing_nonces WHERE id = ? AND team_id = ?',
    [pairingId, teamId],
  );
  if (!pairing) return { reason: 'not_found' };
  if (pairing.member_id !== memberId) return { reason: 'not_owner' };
  if (pairing.consumed_at !== null || pairing.state !== 'awaiting_confirmation')
    return { reason: 'not_awaiting_confirmation' };
  return { pairing };
}

/**
 * Confirm on the original surface (spec §Pairing step 4): only the member who started the
 * pairing, only from the staged state, and the binding created is the daemon-held tenant and
 * user. The binding's generation is one past the highest ever issued for this identity, so a
 * re-pair after revoke can never resurrect a generation an outstanding token names.
 */
export async function confirmPairing(
  db: Driver,
  input: { teamId: string; memberId: string; actor: string; pairingId: string; now?: number },
): Promise<{ ok: true; binding: ChannelBinding } | { ok: false; reason: PairingRefusal }> {
  const now = input.now ?? Date.now();
  return db.tx(async (t) => {
    const loaded = await loadOwnedPairing(t, input.teamId, input.memberId, input.pairingId);
    if ('reason' in loaded) return { ok: false as const, reason: loaded.reason };
    const { pairing } = loaded;
    if (now >= pairing.expires_at) {
      await t.run('UPDATE pairing_nonces SET consumed_at = ? WHERE id = ?', [now, pairing.id]);
      return { ok: false as const, reason: 'expired' as const };
    }
    const prior = await t.get<{ generation: number | null }>(
      `SELECT MAX(generation) AS generation FROM channel_bindings
        WHERE team_id = ? AND channel = ? AND provider_tenant_id = ? AND provider_user_id = ?`,
      [input.teamId, pairing.channel, pairing.provider_tenant_id, pairing.provider_user_id],
    );
    const binding: ChannelBinding = {
      id: ulid(now),
      team_id: input.teamId,
      member_id: input.memberId,
      channel: pairing.channel,
      provider_tenant_id: pairing.provider_tenant_id!,
      provider_user_id: pairing.provider_user_id!,
      generation: (prior?.generation ?? 0) + 1,
      status: 'active',
      created_at: now,
      revoked_at: null,
    };
    await t.run(
      `INSERT INTO channel_bindings
         (id, team_id, member_id, channel, provider_tenant_id, provider_user_id, generation,
          status, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, NULL)`,
      [
        binding.id,
        binding.team_id,
        binding.member_id,
        binding.channel,
        binding.provider_tenant_id,
        binding.provider_user_id,
        binding.generation,
        binding.created_at,
      ],
    );
    await t.run("UPDATE pairing_nonces SET state = 'confirmed', consumed_at = ? WHERE id = ?", [
      now,
      pairing.id,
    ]);
    await appendAudit(t, input.teamId, {
      actor: input.actor,
      action: 'channel.pair.confirmed',
      target: binding.id,
      result: 'allow',
      detail: {
        channel: binding.channel,
        provider_tenant_id: binding.provider_tenant_id,
        provider_user_id: binding.provider_user_id,
        binding_generation: binding.generation,
      },
    });
    return { ok: true as const, binding };
  });
}

/** Reject a staged pairing on the original surface: the nonce dies, nothing is bound. */
export async function rejectPairing(
  db: Driver,
  input: { teamId: string; memberId: string; actor: string; pairingId: string; now?: number },
): Promise<{ ok: true } | { ok: false; reason: PairingRefusal }> {
  const now = input.now ?? Date.now();
  return db.tx(async (t) => {
    const loaded = await loadOwnedPairing(t, input.teamId, input.memberId, input.pairingId);
    if ('reason' in loaded) return { ok: false as const, reason: loaded.reason };
    await t.run("UPDATE pairing_nonces SET state = 'rejected', consumed_at = ? WHERE id = ?", [
      now,
      loaded.pairing.id,
    ]);
    await appendAudit(t, input.teamId, {
      actor: input.actor,
      action: 'channel.pair.rejected',
      target: loaded.pairing.id,
      result: 'deny',
      detail: {
        channel: loaded.pairing.channel,
        provider_tenant_id: loaded.pairing.provider_tenant_id,
        provider_user_id: loaded.pairing.provider_user_id,
      },
    });
    return { ok: true as const };
  });
}

/** Bindings for one member, newest first — the list surface (ADR 618 §7: listed there). */
export async function listBindings(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<ChannelBinding[]> {
  return db.all<ChannelBinding>(
    'SELECT * FROM channel_bindings WHERE team_id = ? AND member_id = ? ORDER BY created_at DESC',
    [teamId, memberId],
  );
}

/** The binding redemption re-reads (ADR 623 §6): current generation and active, else stale. */
export async function channelBindingStanding(
  db: Driver,
  teamId: string,
  bindingId: string,
  generation: number,
): Promise<BindingStanding> {
  const row = await db.get<{ status: string; generation: number }>(
    'SELECT status, generation FROM channel_bindings WHERE id = ? AND team_id = ?',
    [bindingId, teamId],
  );
  if (!row) return 'stale';
  return row.status === 'active' && row.generation === generation ? 'current' : 'stale';
}

/** Consume every outstanding ask token that names this binding; returns how many died. */
async function consumeBindingTokens(t: Driver, teamId: string, bindingId: string, now: number) {
  const res = await t.run(
    `UPDATE ask_channel_tokens SET consumed_at = ?
      WHERE team_id = ? AND binding_id = ? AND consumed_at IS NULL`,
    [now, teamId, bindingId],
  );
  return res.changes;
}

/**
 * Revoke one binding (ADR 618 §7): the binding dies at its generation and every outstanding
 * token naming it is consumed in the same transaction, so a replayed answer after revoke is
 * refused on both checks. Audited as `channel.pair.revoked`.
 */
export async function revokeBinding(
  db: Driver,
  input: { teamId: string; memberId: string; actor: string; bindingId: string; now?: number },
): Promise<{ ok: true; tokensRevoked: number } | { ok: false; reason: PairingRefusal }> {
  const now = input.now ?? Date.now();
  return db.tx(async (t) => {
    const binding = await t.get<ChannelBinding>(
      'SELECT * FROM channel_bindings WHERE id = ? AND team_id = ?',
      [input.bindingId, input.teamId],
    );
    if (!binding) return { ok: false as const, reason: 'not_found' as const };
    if (binding.member_id !== input.memberId)
      return { ok: false as const, reason: 'not_owner' as const };
    if (binding.status !== 'active') return { ok: true as const, tokensRevoked: 0 };
    await t.run("UPDATE channel_bindings SET status = 'revoked', revoked_at = ? WHERE id = ?", [
      now,
      binding.id,
    ]);
    const tokensRevoked = await consumeBindingTokens(t, input.teamId, binding.id, now);
    await appendAudit(t, input.teamId, {
      actor: input.actor,
      action: 'channel.pair.revoked',
      target: binding.id,
      result: 'allow',
      detail: {
        channel: binding.channel,
        provider_tenant_id: binding.provider_tenant_id,
        provider_user_id: binding.provider_user_id,
        binding_generation: binding.generation,
        tokens_revoked: tokensRevoked,
      },
    });
    return { ok: true as const, tokensRevoked };
  });
}

/**
 * The kill switch (ADR 618 §7, spec: Channel settings): disable all channel answers for a
 * member — revoke every active binding generation and every outstanding decision token — in
 * one transaction, with no relay cooperation. Audited as `channel.killswitch`.
 */
export async function killSwitchChannels(
  db: Driver,
  input: { teamId: string; memberId: string; actor: string; now?: number },
): Promise<{ bindingsRevoked: number; tokensRevoked: number }> {
  const now = input.now ?? Date.now();
  return db.tx(async (t) => {
    const bindings = await t.all<ChannelBinding>(
      "SELECT * FROM channel_bindings WHERE team_id = ? AND member_id = ? AND status = 'active'",
      [input.teamId, input.memberId],
    );
    let tokensRevoked = 0;
    for (const binding of bindings) {
      await t.run("UPDATE channel_bindings SET status = 'revoked', revoked_at = ? WHERE id = ?", [
        now,
        binding.id,
      ]);
      tokensRevoked += await consumeBindingTokens(t, input.teamId, binding.id, now);
    }
    await appendAudit(t, input.teamId, {
      actor: input.actor,
      action: 'channel.killswitch',
      target: null,
      result: 'allow',
      detail: { bindings_revoked: bindings.length, tokens_revoked: tokensRevoked },
    });
    return { bindingsRevoked: bindings.length, tokensRevoked };
  });
}
