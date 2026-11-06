import { createHash, createPublicKey } from 'node:crypto';
import type { X509Certificate } from 'node:crypto';
import {
  APP_CHANNEL,
  APP_PAIRING_BINDING,
  APP_QR_VERSION,
  AppPairRequestSchema,
  type AppPairingQr,
  type ApprovalProof,
} from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import {
  appChannelKeyBornAt,
  loadAppChannelKeys,
  openFromPhone,
  type AppChannelKeys,
  type SealedBody,
} from '../notify/appSeal.js';
import { appPairingChallenge, verifyAppAttestation, type AppAttestRefusal } from './appAttest.js';
import { appendAudit } from './audit.js';
import {
  enrollKeyGuarded,
  getDeviceKey,
  revokeDeviceKey,
  type EnrollKeyResult,
} from './authority.js';
import {
  confirmPairing,
  startPairing,
  type ChannelBinding,
  type Pairing,
  type PairingRefusal,
} from './channelBindings.js';
import { getChannelSettings, setChannelSettings } from './channelSettings.js';

/**
 * Pairing the musterd app (ADR 676 §5). The daemon's own page starts it and shows a QR code with
 * the relay route, the one-time pairing code and both daemon public keys. The phone answers
 * through the relay with a request sealed to the daemon: its signing and receive public keys and
 * an App Attest attestation whose challenge binds the code and both keys. Staging verifies all
 * of it and binds nothing. Only the human's standing authenticator — a passkey or the laptop key —
 * then approves the phone's signing key as a `device_key_admin` act (ADR 662 decision 6); the
 * phone is never its own approval. The binding keeps the phone's public keys: the receive key
 * every delivery is sealed to, and the device key every answer is signed with.
 *
 * Any refused request consumes the pairing: a forged attestation gets one try, not five.
 */

export interface AppKeys {
  /** The phone's signing key, P-256 uncompressed point, base64url (the `phone` device key). */
  signing_public_key: string;
  /** The phone's receive key, P-256 uncompressed point, base64url (deliveries are sealed to it). */
  receive_public_key: string;
  attest_key_id: string;
  environment: 'production' | 'development';
  device_name?: string;
  /** Set on the binding once the signing key is enrolled. */
  device_key_id?: string;
  /** The phone's APNs device token (hex) and its environment; absent, nothing is pushed. */
  push_token?: string;
  push_environment?: 'production' | 'development';
  /** ADR 774 §5: the phone's question key — P-256 uncompressed point, base64url, no biometry. It
   *  signs answers to questions only. Absent until the phone enrolls it. */
  question_key?: string;
  question_key_at?: number;
  /** The enrollment nonces already used on this binding (newest last, bounded) — a replayed
   *  enrollment cannot roll the key back. */
  question_key_nonces?: string[];
  /** The sealed `expires_at` of the last accepted enrollment — enrollments are accepted in order. */
  question_key_expires_at?: number;
  /** ADR 802 §1: the daemon identity key the phone pinned at pairing (Ed25519 raw, base64url), or
   *  `unknown-before-key` for a binding from before this was recorded whose key the backfill could
   *  not vouch for. Compared with the daemon's current key to tell a pairing that ended. */
  daemon_identity_public_key?: string;
  /** ADR 791: the quick-action nonces already used on this binding (newest last, bounded). With the
   *  ten-minute seal window this makes a replayed quick action a no-op. */
  quick_action_nonces?: string[];
}

export type AppPairingRefusal =
  | PairingRefusal
  | 'sealed_body'
  | 'bad_request'
  | 'wrong_channel'
  | 'code_mismatch'
  | AppAttestRefusal;

const sha256hex = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');

/** The P-256 SPKI (DER, base64url) for a raw uncompressed point — the form device_keys stores. */
export function p256SpkiFromRaw(raw: string): string {
  const point = Buffer.from(raw, 'base64url');
  const key = createPublicKey({
    key: {
      kty: 'EC',
      crv: 'P-256',
      x: point.subarray(1, 33).toString('base64url'),
      y: point.subarray(33, 65).toString('base64url'),
    },
    format: 'jwk',
  });
  return key.export({ format: 'der', type: 'spki' }).toString('base64url');
}

/** One key's fingerprint: the phone key a confirm enrolls, shown beside the pairing request. */
export function keyFingerprint(raw: string): string {
  return sha256hex(Buffer.from(raw, 'base64url')).slice(0, 16).match(/.{4}/g)!.join(' ');
}

const PAIRING_FINGERPRINT_TAG = Buffer.from('musterd/pairing-fingerprint/v1', 'utf8');

/**
 * What the page and the CLI show beside the QR, and what the phone shows after scanning (ADR 788):
 * sha256 of the v1 tag, the raw Ed25519 identity key (32 bytes) and the raw P-256 receive key
 * (65 bytes), first 16 hex in fours. It covers both keys because the phone seals its pair request
 * and its answers to the receive key: a QR with a swapped receive key must not match the page.
 * The phone's `daemonFingerprint` in `packages/mobile/src/native/pairingQr.ts` is the same function.
 */
export function pairingFingerprint(identityRaw: string, receiveRaw: string): string {
  const identity = Buffer.from(identityRaw, 'base64url');
  const receive = Buffer.from(receiveRaw, 'base64url');
  if (identity.length !== 32 || receive.length !== 65) {
    throw new Error('pairing fingerprint: identity must be 32 bytes and receive 65');
  }
  return sha256hex(Buffer.concat([PAIRING_FINGERPRINT_TAG, identity, receive]))
    .slice(0, 16)
    .match(/.{4}/g)!
    .join(' ');
}

/** Start an app pairing on the daemon's own page: the pairing row and the QR payload, shown once. */
export async function startAppPairing(
  db: Driver,
  input: {
    teamId: string;
    teamSlug: string;
    memberId: string;
    actor: string;
    relayUrl: string;
    keys: AppChannelKeys;
    now?: number;
  },
): Promise<{ pairing: Pairing; qr: AppPairingQr }> {
  const { pairing, nonce } = await startPairing(db, {
    teamId: input.teamId,
    memberId: input.memberId,
    actor: input.actor,
    channel: APP_CHANNEL,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
  return {
    pairing,
    qr: {
      v: APP_QR_VERSION,
      relay: input.relayUrl,
      team: input.teamSlug,
      pairing: pairing.id,
      code: nonce,
      expires_at: pairing.expires_at,
      daemon_identity_public_key: input.keys.identityPublic,
      daemon_receive_public_key: input.keys.receivePublic,
    },
  };
}

type PairingRow = Pairing & { nonce_hash: string; app_keys: string | null };

/**
 * A sealed pairing request arrives through the relay. Open it, check the code, verify the
 * attestation, and stage the phone's keys for the human to approve. Binds nothing.
 */
export async function stageAppPairing(
  db: Driver,
  input: {
    teamId: string;
    teamSlug: string;
    pairingId: string;
    sealed: SealedBody;
    keys: AppChannelKeys;
    appId: string;
    now?: number;
    /** Tests only: the App Attest roots to trust (production always uses Apple's). */
    attestRoots?: X509Certificate[];
  },
): Promise<{ ok: true; pairing: Pairing } | { ok: false; reason: AppPairingRefusal }> {
  const now = input.now ?? Date.now();
  const row = await db.get<PairingRow>(
    'SELECT * FROM pairing_nonces WHERE id = ? AND team_id = ?',
    [input.pairingId, input.teamId],
  );
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.channel !== APP_CHANNEL) return { ok: false, reason: 'wrong_channel' };

  const refuse = async (
    reason: AppPairingRefusal,
  ): Promise<{ ok: false; reason: AppPairingRefusal }> => {
    await db.run('UPDATE pairing_nonces SET consumed_at = COALESCE(consumed_at, ?) WHERE id = ?', [
      now,
      row.id,
    ]);
    await appendAudit(db, input.teamId, {
      actor: null,
      action: 'channel.app_paired',
      target: row.id,
      result: 'deny',
      detail: { reason },
    });
    return { ok: false, reason };
  };

  if (row.consumed_at !== null) return { ok: false, reason: 'consumed' };
  if (now >= row.expires_at) return refuse('expired');
  if (row.state !== 'awaiting_identity') return refuse('not_awaiting_identity');

  let opened: Uint8Array;
  try {
    opened = await openFromPhone({
      keys: input.keys,
      route: {
        team: input.teamSlug,
        binding: APP_PAIRING_BINDING,
        ref: row.id,
        expires_at: row.expires_at,
      },
      sealed: input.sealed,
      purpose: 'pair',
    });
  } catch {
    return refuse('sealed_body');
  }
  let request;
  try {
    request = AppPairRequestSchema.parse(JSON.parse(new TextDecoder().decode(opened)));
  } catch {
    return refuse('bad_request');
  }
  if (sha256hex(request.code) !== row.nonce_hash) return refuse('code_mismatch');

  const signingRaw = Buffer.from(request.signing_public_key, 'base64url');
  const receiveRaw = Buffer.from(request.receive_public_key, 'base64url');
  try {
    p256SpkiFromRaw(request.signing_public_key);
    p256SpkiFromRaw(request.receive_public_key);
  } catch {
    return refuse('bad_request');
  }
  const verdict = verifyAppAttestation({
    attestation: Buffer.from(request.attestation, 'base64url'),
    clientDataHash: appPairingChallenge(request.code, signingRaw, receiveRaw),
    keyId: Buffer.from(request.attest_key_id, 'base64url'),
    appId: input.appId,
    now,
    ...(input.attestRoots ? { roots: input.attestRoots } : {}),
  });
  if (!verdict.ok) return refuse(verdict.reason);

  const appKeys: AppKeys = {
    signing_public_key: request.signing_public_key,
    receive_public_key: request.receive_public_key,
    attest_key_id: verdict.keyId,
    environment: verdict.environment,
    // ADR 802 §1: the seal opened with these keys, so this is the key the phone pinned.
    daemon_identity_public_key: input.keys.identityPublic,
    ...(request.device_name ? { device_name: request.device_name } : {}),
    ...(request.push_token
      ? {
          push_token: request.push_token,
          push_environment: request.push_environment ?? verdict.environment,
        }
      : {}),
  };
  // The provider identity a binding is keyed on: the App Attest key (tenant) and the phone's
  // signing key fingerprint (user). Both are fixed for the life of this install.
  const staged = await db.run(
    `UPDATE pairing_nonces SET state = 'awaiting_confirmation', provider_tenant_id = ?,
       provider_user_id = ?, app_keys = ?
     WHERE id = ? AND state = 'awaiting_identity' AND consumed_at IS NULL`,
    [verdict.keyId, sha256hex(signingRaw), JSON.stringify(appKeys), row.id],
  );
  if (staged.changes !== 1) return { ok: false, reason: 'not_awaiting_identity' };
  const pairing = await db.get<Pairing>('SELECT * FROM pairing_nonces WHERE id = ?', [row.id]);
  return { ok: true, pairing: pairing! };
}

/** The phone keys staged on a pairing, for the confirmation surface to show and approve. */
export async function stagedAppKeys(
  db: Driver,
  teamId: string,
  pairingId: string,
): Promise<AppKeys | null> {
  const row = await db.get<{ app_keys: string | null; channel: string }>(
    'SELECT app_keys, channel FROM pairing_nonces WHERE id = ? AND team_id = ?',
    [pairingId, teamId],
  );
  if (!row || row.channel !== APP_CHANNEL || !row.app_keys) return null;
  return JSON.parse(row.app_keys) as AppKeys;
}

/** The descriptor payload a standing key signs to approve this phone (ADR 662 `device_key_admin`). */
export function appEnrollPayload(keys: AppKeys): {
  action: 'enroll';
  public_key: string;
  kind: 'phone';
} {
  return { action: 'enroll', public_key: p256SpkiFromRaw(keys.signing_public_key), kind: 'phone' };
}

/**
 * The human confirms on the daemon's page with a standing key's signature. The phone's signing
 * key is enrolled as kind `phone` through ADR 662's guarded path, then the binding is created and
 * keeps the phone's keys.
 */
export async function confirmAppPairing(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    member: { id: string; name: string; kind: string };
    pairingId: string;
    proof?: ApprovalProof | undefined;
    now?: number;
    /** The daemon's configured WebAuthn origins; a passkey approval cannot verify without them. */
    expectedOrigins?: string[];
  },
): Promise<
  | { ok: true; binding: ChannelBinding; deviceKeyId: string }
  | { ok: false; reason: AppPairingRefusal | Extract<EnrollKeyResult, { ok: false }>['reason'] }
> {
  const now = input.now ?? Date.now();
  const row = await db.get<PairingRow>(
    'SELECT * FROM pairing_nonces WHERE id = ? AND team_id = ?',
    [input.pairingId, input.teamId],
  );
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.channel !== APP_CHANNEL || !row.app_keys) return { ok: false, reason: 'wrong_channel' };
  if (row.member_id !== input.member.id) return { ok: false, reason: 'not_owner' };
  if (row.consumed_at !== null || row.state !== 'awaiting_confirmation')
    return { ok: false, reason: 'not_awaiting_confirmation' };
  if (now >= row.expires_at) return { ok: false, reason: 'expired' };
  const keys = JSON.parse(row.app_keys) as AppKeys;

  const enrolled = await enrollKeyGuarded(db, {
    teamId: input.teamId,
    audience: input.audience,
    member: input.member,
    publicKey: appEnrollPayload(keys).public_key,
    kind: 'phone',
    proof: input.proof,
    expectedOrigins: input.expectedOrigins,
    now,
  });
  if (!enrolled.ok) return { ok: false, reason: enrolled.reason };

  const confirmed = await confirmPairing(db, {
    teamId: input.teamId,
    memberId: input.member.id,
    actor: input.member.name,
    pairingId: row.id,
    now,
    allowApp: true,
  });
  if (!confirmed.ok) return { ok: false, reason: confirmed.reason };
  const bound: AppKeys = { ...keys, device_key_id: enrolled.key.id };
  await db.run('UPDATE channel_bindings SET app_keys = ? WHERE id = ?', [
    JSON.stringify(bound),
    confirmed.binding.id,
  ]);
  // The pairings this one replaces (a re-pair after a daemon key change) lose their phone keys now.
  await revokePhoneKeysOfEndedBindings(db, {
    teamId: input.teamId,
    member: { id: input.member.id, name: input.member.name },
    now,
    // The key this pairing was just confirmed under is, by construction, the daemon's current one.
    ...(bound.daemon_identity_public_key ? { current: bound.daemon_identity_public_key } : {}),
  });
  await appendAudit(db, input.teamId, {
    actor: input.member.name,
    action: 'channel.app_paired',
    target: confirmed.binding.id,
    result: 'allow',
    detail: {
      binding_generation: confirmed.binding.generation,
      device_key_id: enrolled.key.id,
      attest_key_id: keys.attest_key_id,
      environment: keys.environment,
      attestation: 'verified',
    },
  });
  // ADR 759: the human's passkey approval of this phone is the opt-in. Delivery and answering turn
  // on here, so an ask reaches the phone without a second trip to the settings. Presence gating
  // and a tier floor the human already chose are kept; a first pairing gets the gating default.
  const prior = await getChannelSettings(db, input.teamId, input.member.id, APP_CHANNEL);
  await setChannelSettings(db, {
    teamId: input.teamId,
    memberId: input.member.id,
    actor: input.member.name,
    settings: { ...prior, deliver: true, answer: true },
    now,
  });
  return { ok: true, binding: confirmed.binding, deviceKeyId: enrolled.key.id };
}

/** The phone keys on an active app binding — what a delivery is sealed to. */
export async function appBindingKeys(
  db: Driver,
  teamId: string,
  bindingId: string,
): Promise<AppKeys | null> {
  const row = await db.get<{ app_keys: string | null; channel: string; status: string }>(
    'SELECT app_keys, channel, status FROM channel_bindings WHERE id = ? AND team_id = ?',
    [bindingId, teamId],
  );
  if (!row || row.channel !== APP_CHANNEL || row.status !== 'active' || !row.app_keys) return null;
  return JSON.parse(row.app_keys) as AppKeys;
}

/** A daemon key the backfill could not vouch for (ADR 802 §2): reads as superseded. */
export const UNKNOWN_DAEMON_KEY = 'unknown-before-key';

/**
 * A pairing's phone key dies with the pairing (lane 01M6Q1RDTK). Every app pairing enrolls a fresh
 * kind `phone` device key and records it on the binding as `device_key_id`; until 2026-11-05
 * nothing read that back when the binding ended, so a superseded or revoked pairing's key stayed
 * active — nick's /live said "your 3 paired phones also sign" with one phone paired, one key per
 * pairing round, and each still counted as standing authority. A pairing ends two ways (ADR 802):
 * revoked, or superseded by a daemon key change that no row records. So this is a sweep over the
 * member's app bindings, not a hook on one event: it runs when a pairing is confirmed, when one is
 * revoked, and when the member's keys are listed — the surface where the stale count showed.
 * Idempotent; audited per key as `device_key.revoked` with `via: binding_<reason>`.
 */
/**
 * The boot half of lane 01M6Q1RDTK: every member's ended app pairings lose their phone keys once,
 * for rows from before the lifecycle was closed (a supersession is derived from the daemon key, so
 * no event ever fired for it). Idempotent; a daemon that boots clean sweeps nothing.
 */
export async function revokePhoneKeysOfEndedBindingsEverywhere(
  db: Driver,
  opts: { now?: number } = {},
): Promise<{ members: number; keys: number }> {
  const rows = await db.all<{ team_id: string; member_id: string; name: string }>(
    `SELECT DISTINCT b.team_id, b.member_id, m.name
       FROM channel_bindings b JOIN members m ON m.id = b.member_id
      WHERE b.channel = ? AND b.app_keys IS NOT NULL`,
    [APP_CHANNEL],
  );
  let keys = 0;
  for (const row of rows) {
    const swept = await revokePhoneKeysOfEndedBindings(db, {
      teamId: row.team_id,
      member: { id: row.member_id, name: row.name },
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    keys += swept.length;
  }
  return { members: rows.length, keys };
}

/**
 * Is this phone key's pairing over (lane 01M6Q1RDTK)? The authority boundary reads this at use
 * time, so a key whose pairing was superseded by a daemon key change — an event no row records —
 * is refused before any sweep has run. A phone key with no app binding at all is treated as ended:
 * kind `phone` always means App Attest vouched for it through a pairing.
 */
export async function phoneKeyPairingEnded(
  db: Driver,
  teamId: string,
  keyId: string,
  opts: { current?: string; keyBornAt?: number } = {},
): Promise<AppBindingEnded | 'unpaired' | null> {
  const row = await db.get<{ id: string }>(
    `SELECT id FROM channel_bindings
      WHERE team_id = ? AND channel = ? AND json_extract(app_keys, '$.device_key_id') = ?
      ORDER BY created_at DESC LIMIT 1`,
    [teamId, APP_CHANNEL, keyId],
  );
  if (!row) return 'unpaired';
  return await appBindingEnded(db, teamId, row.id, opts);
}

export async function revokePhoneKeysOfEndedBindings(
  db: Driver,
  input: {
    teamId: string;
    member: { id: string; name: string };
    now?: number;
    /** Test seams for {@link appBindingEnded}. */
    current?: string;
    keyBornAt?: number;
  },
): Promise<{ keyId: string; binding: string; ended: AppBindingEnded }[]> {
  const now = input.now ?? Date.now();
  const rows = await db.all<{ id: string; app_keys: string | null }>(
    `SELECT id, app_keys FROM channel_bindings
      WHERE team_id = ? AND member_id = ? AND channel = ? AND app_keys IS NOT NULL`,
    [input.teamId, input.member.id, APP_CHANNEL],
  );
  const revoked: { keyId: string; binding: string; ended: AppBindingEnded }[] = [];
  for (const row of rows) {
    const keys = JSON.parse(row.app_keys ?? '{}') as AppKeys;
    if (!keys.device_key_id) continue;
    const key = await getDeviceKey(db, input.teamId, keys.device_key_id);
    if (!key || key.kind !== 'phone' || key.revokedAt !== null) continue;
    const ended = await appBindingEnded(db, input.teamId, row.id, {
      ...(input.current !== undefined ? { current: input.current } : {}),
      ...(input.keyBornAt !== undefined ? { keyBornAt: input.keyBornAt } : {}),
    });
    if (!ended) continue;
    await revokeDeviceKey(db, input.teamId, key.id, now);
    await appendAudit(db, input.teamId, {
      actor: input.member.name,
      action: 'device_key.revoked',
      target: input.member.name,
      result: 'allow',
      detail: { key_id: key.id, via: `binding_${ended}`, binding: row.id },
    });
    revoked.push({ keyId: key.id, binding: row.id, ended });
  }
  return revoked;
}

export type AppBindingEnded = 'superseded' | 'revoked';

/**
 * Has this app binding ended (ADR 802 §2)? `revoked` when it was revoked; `superseded` when the
 * daemon key the phone pinned is not the daemon's current one; else `null`. A binding from before
 * the key was recorded is backfilled once: the current key if it was paired after the key file was
 * written, else {@link UNKNOWN_DAEMON_KEY}. The backfill never overwrites a recorded key.
 */
export async function appBindingEnded(
  db: Driver,
  teamId: string,
  bindingId: string,
  opts: { current?: string; keyBornAt?: number } = {},
): Promise<AppBindingEnded | null> {
  const row = await db.get<{
    app_keys: string | null;
    channel: string;
    status: string;
    created_at: number;
  }>(
    'SELECT app_keys, channel, status, created_at FROM channel_bindings WHERE id = ? AND team_id = ?',
    [bindingId, teamId],
  );
  if (!row || row.channel !== APP_CHANNEL) return null;
  if (row.status !== 'active') return 'revoked';
  if (!row.app_keys) return null;
  const current = opts.current ?? (await loadAppChannelKeys()).identityPublic;
  let recorded = (JSON.parse(row.app_keys) as AppKeys).daemon_identity_public_key;
  if (!recorded) {
    const bornAt = opts.keyBornAt ?? appChannelKeyBornAt();
    const guess = row.created_at >= bornAt ? current : UNKNOWN_DAEMON_KEY;
    recorded = await db.tx(async (t) => {
      const fresh = await t.get<{ app_keys: string | null }>(
        'SELECT app_keys FROM channel_bindings WHERE id = ? AND team_id = ?',
        [bindingId, teamId],
      );
      const keys = JSON.parse(fresh?.app_keys ?? '{}') as AppKeys;
      if (keys.daemon_identity_public_key) return keys.daemon_identity_public_key;
      await t.run('UPDATE channel_bindings SET app_keys = ? WHERE id = ? AND team_id = ?', [
        JSON.stringify({ ...keys, daemon_identity_public_key: guess }),
        bindingId,
        teamId,
      ]);
      return guess;
    });
  }
  return recorded === current ? null : 'superseded';
}

/**
 * ADR 774 §5: record (or replace) the binding's question key inside its `app_keys`, in order.
 *
 * The enrollment's seal binds its `expires_at` (the relay cannot change it), and the phone stamps it
 * from its clock, so it only grows. An enrollment whose `expires_at` is not past the last accepted
 * one — a replay, or an older one the relay held back and delivered late — cannot roll the key back.
 * The check and the write share one transaction, so two racing enrollments cannot both pass.
 */
export async function setAppQuestionKey(
  db: Driver,
  teamId: string,
  bindingId: string,
  enroll: { questionKey: string; nonce: string; expiresAt: number },
  now: number,
): Promise<'ok' | 'binding_stale' | 'replayed'> {
  return db.tx(async (t) => {
    const row = await t.get<{ app_keys: string | null; channel: string; status: string }>(
      'SELECT app_keys, channel, status FROM channel_bindings WHERE id = ? AND team_id = ?',
      [bindingId, teamId],
    );
    if (!row || row.channel !== APP_CHANNEL || row.status !== 'active' || !row.app_keys)
      return 'binding_stale';
    const keys = JSON.parse(row.app_keys) as AppKeys;
    if (
      (keys.question_key_nonces ?? []).includes(enroll.nonce) ||
      enroll.expiresAt <= (keys.question_key_expires_at ?? 0)
    )
      return 'replayed';
    const next: AppKeys = {
      ...keys,
      question_key: enroll.questionKey,
      question_key_at: now,
      question_key_expires_at: enroll.expiresAt,
      question_key_nonces: [...(keys.question_key_nonces ?? []), enroll.nonce].slice(-32),
    };
    // Compare-and-swap on the value just read: Postgres's READ COMMITTED lets two enrollments read
    // the same keys, and only the first write may land. The loser saw a stale order — `replayed`.
    const swapped = await t.run(
      'UPDATE channel_bindings SET app_keys = ? WHERE id = ? AND team_id = ? AND app_keys = ?',
      [JSON.stringify(next), bindingId, teamId, row.app_keys],
    );
    return swapped.changes === 1 ? 'ok' : 'replayed';
  });
}

/** How many used quick-action nonces a binding remembers — far more than ten minutes of presses. */
export const QUICK_ACTION_NONCES_KEPT = 128;

/**
 * Spend a quick action's nonce on this binding (ADR 791): `replayed` when it was spent before.
 * Compare-and-swap on the value just read, like {@link setAppQuestionKey}, so two deliveries of one
 * sealed request cannot both pass.
 */
export async function spendAppQuickActionNonce(
  db: Driver,
  teamId: string,
  bindingId: string,
  nonce: string,
): Promise<'ok' | 'binding_stale' | 'replayed'> {
  return db.tx(async (t) => {
    const row = await t.get<{ app_keys: string | null; channel: string; status: string }>(
      'SELECT app_keys, channel, status FROM channel_bindings WHERE id = ? AND team_id = ?',
      [bindingId, teamId],
    );
    if (!row || row.channel !== APP_CHANNEL || row.status !== 'active' || !row.app_keys)
      return 'binding_stale';
    const keys = JSON.parse(row.app_keys) as AppKeys;
    if ((keys.quick_action_nonces ?? []).includes(nonce)) return 'replayed';
    const next: AppKeys = {
      ...keys,
      quick_action_nonces: [...(keys.quick_action_nonces ?? []), nonce].slice(
        -QUICK_ACTION_NONCES_KEPT,
      ),
    };
    const swapped = await t.run(
      'UPDATE channel_bindings SET app_keys = ? WHERE id = ? AND team_id = ? AND app_keys = ?',
      [JSON.stringify(next), bindingId, teamId, row.app_keys],
    );
    return swapped.changes === 1 ? 'ok' : 'replayed';
  });
}
