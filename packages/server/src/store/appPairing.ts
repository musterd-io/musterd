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
import { openFromPhone, type AppChannelKeys, type SealedBody } from '../notify/appSeal.js';
import { appPairingChallenge, verifyAppAttestation, type AppAttestRefusal } from './appAttest.js';
import { appendAudit } from './audit.js';
import { enrollKeyGuarded, type EnrollKeyResult } from './authority.js';
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

/** What the page shows beside the QR code so the phone's screen can be compared with it. */
export function keyFingerprint(raw: string): string {
  return sha256hex(Buffer.from(raw, 'base64url')).slice(0, 16).match(/.{4}/g)!.join(' ');
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

/** ADR 774 §5: record (or replace) the binding's question key inside its `app_keys`. */
export async function setAppQuestionKey(
  db: Driver,
  teamId: string,
  bindingId: string,
  questionKey: string,
  now: number,
): Promise<boolean> {
  const keys = await appBindingKeys(db, teamId, bindingId);
  if (!keys) return false;
  const next: AppKeys = { ...keys, question_key: questionKey, question_key_at: now };
  await db.run('UPDATE channel_bindings SET app_keys = ? WHERE id = ? AND team_id = ?', [
    JSON.stringify(next),
    bindingId,
    teamId,
  ]);
  return true;
}
