import { createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import {
  descriptorSigningBytes,
  payloadDigest,
  type ApprovalDescriptor,
  type ApprovalProof,
  type AuthenticatorKind,
  type AuthorityRefusalReason,
  type HighAuthorityAct,
} from '@musterd/protocol';
import { ulid } from 'ulid';
import type { Driver } from '../db/driver.js';
import { appendAudit } from './audit.js';

/**
 * Human authority (ADR 662, lane 01M5ANFFVHY07ZTYEECTRSTXTN): the device keys a human's
 * authority is bound to, the server-built approval descriptors, and the one gate every listed
 * act passes. Authorization is enforced here, in code — never by a prompt (hard rule: a
 * Bearer [REDACTED] an agent can read performs no listed act once its human is enrolled).
 *
 * Activation is per-human (nick, 2026-10-19): an agent-kind credential is refused for a
 * listed act outright; a human with an enrolled device key must present a fresh A2 signature;
 * a human with no enrolled key yet proceeds on the old path, and the gate closes when lanes
 * 1–3 have landed and humans are enrolled (ADR 662, Consequences).
 */

const DESCRIPTOR_TTL_MS = 5 * 60 * 1000;

export interface DeviceKey {
  id: string;
  memberId: string;
  publicKey: string;
  kind: AuthenticatorKind;
  createdAt: number;
  revokedAt: number | null;
}

interface DeviceKeyRow {
  id: string;
  member_id: string;
  public_key: string;
  kind: string;
  created_at: number;
  revoked_at: number | null;
}

const toKey = (r: DeviceKeyRow): DeviceKey => ({
  id: r.id,
  memberId: r.member_id,
  publicKey: r.public_key,
  kind: r.kind as AuthenticatorKind,
  createdAt: Number(r.created_at),
  revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
});

/** Record a device key's public half (Ed25519 SPKI, base64url). Lane 2 owns the enrollment
 * flow that decides whose key this may be; this is only the store. */
export async function enrollDeviceKey(
  db: Driver,
  input: {
    teamId: string;
    memberId: string;
    publicKey: string;
    kind: AuthenticatorKind;
    now?: number;
  },
): Promise<DeviceKey> {
  const now = input.now ?? Date.now();
  const key: DeviceKey = {
    id: ulid(now),
    memberId: input.memberId,
    publicKey: input.publicKey,
    kind: input.kind,
    createdAt: now,
    revokedAt: null,
  };
  await db.run(
    `INSERT INTO device_keys (id, team_id, member_id, public_key, kind, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL)`,
    [key.id, input.teamId, key.memberId, key.publicKey, key.kind, now],
  );
  return key;
}

export async function listDeviceKeys(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<DeviceKey[]> {
  const rows = await db.all<DeviceKeyRow>(
    `SELECT id, member_id, public_key, kind, created_at, revoked_at FROM device_keys
      WHERE team_id = ? AND member_id = ? ORDER BY created_at`,
    [teamId, memberId],
  );
  return rows.map(toKey);
}

/** The member's keys that can still sign: enrolled and not revoked. */
export async function activeDeviceKeys(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<DeviceKey[]> {
  return (await listDeviceKeys(db, teamId, memberId)).filter((k) => k.revokedAt === null);
}

export async function getDeviceKey(
  db: Driver,
  teamId: string,
  keyId: string,
): Promise<DeviceKey | null> {
  const row = await db.get<DeviceKeyRow>(
    `SELECT id, member_id, public_key, kind, created_at, revoked_at FROM device_keys
      WHERE team_id = ? AND id = ?`,
    [teamId, keyId],
  );
  return row ? toKey(row) : null;
}

export async function revokeDeviceKey(
  db: Driver,
  teamId: string,
  keyId: string,
  now = Date.now(),
): Promise<void> {
  await db.run(`UPDATE device_keys SET revoked_at = ? WHERE team_id = ? AND id = ?`, [
    now,
    teamId,
    keyId,
  ]);
}

interface NonceRow {
  nonce: string;
  member_id: string;
  descriptor_digest: string;
  expires_at: number;
  used_at: number | null;
}

/**
 * Build the descriptor for one act attempt. The server — never the caller — fills every
 * field; the caller's payload enters only through its digest. The nonce is spent by exactly
 * one verified presentation.
 */
export async function buildDescriptor(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    memberId: string;
    actor: string;
    act: HighAuthorityAct;
    target: string;
    payload: unknown;
    now?: number;
  },
): Promise<ApprovalDescriptor> {
  const now = input.now ?? Date.now();
  const descriptor: ApprovalDescriptor = {
    v: 1,
    actor: input.actor,
    act: input.act,
    target: input.target,
    payload_digest: payloadDigest(input.payload),
    audience: input.audience,
    expiry: now + DESCRIPTOR_TTL_MS,
    nonce: randomBytes(32).toString('base64url'),
  };
  await db.run(
    `INSERT INTO approval_nonces (nonce, team_id, member_id, descriptor_digest, expires_at, used_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [
      descriptor.nonce,
      input.teamId,
      input.memberId,
      payloadDigest(descriptorSigningBytes(descriptor)),
      descriptor.expiry,
    ],
  );
  return descriptor;
}

export type AuthorityCheck =
  | { ok: true; assurance: 'A2'; keyId: string; kind: AuthenticatorKind }
  | { ok: true; assurance: 'bearer_unenrolled' }
  | { ok: false; reason: AuthorityRefusalReason };

/**
 * The gate. `presenter` is the member whose authority the act exercises (for
 * `set_authorized_by`, the human named — not the seat relaying the proof). Callers throw or
 * refuse the act on `{ ok: false }`; the refusal is audited here either way it is presented.
 */
export async function requireAuthority(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    presenter: { id: string; name: string; kind: string };
    /** How the caller authenticated: an agent-kind credential never performs a listed act. */
    credential: 'agent' | 'human';
    act: HighAuthorityAct;
    target: string;
    payload: unknown;
    proof?: ApprovalProof | undefined;
    now?: number;
  },
): Promise<AuthorityCheck> {
  const now = input.now ?? Date.now();
  const refuse = async (reason: AuthorityRefusalReason): Promise<AuthorityCheck> => {
    await appendAudit(db, input.teamId, {
      actor: input.presenter.name,
      action: 'authority.refused',
      target: input.target,
      result: 'deny',
      detail: {
        act: input.act,
        reason,
        ...(input.proof ? { key_id: input.proof.key_id } : {}),
      },
    });
    return { ok: false, reason };
  };

  if (input.credential === 'agent' || input.presenter.kind !== 'human') {
    return refuse('agent_credential');
  }
  // Enrollment latches: once a human has ever enrolled a key, the Bearer path is closed for
  // them — revoking every key is the lost-device case (lane 2's recovery), not a reopening.
  const enrolled = await listDeviceKeys(db, input.teamId, input.presenter.id);
  if (enrolled.length === 0) return { ok: true, assurance: 'bearer_unenrolled' };

  const proof = input.proof;
  if (!proof) return refuse('no_signature');

  const nonce = await db.get<NonceRow>(
    `SELECT nonce, member_id, descriptor_digest, expires_at, used_at FROM approval_nonces
      WHERE team_id = ? AND nonce = ?`,
    [input.teamId, proof.nonce],
  );
  if (!nonce || nonce.member_id !== input.presenter.id) return refuse('descriptor_mismatch');
  if (nonce.used_at !== null) return refuse('nonce_reused');
  if (now > Number(nonce.expires_at)) return refuse('expired');

  const key = await getDeviceKey(db, input.teamId, proof.key_id);
  if (!key || key.memberId !== input.presenter.id) return refuse('descriptor_mismatch');
  if (key.revokedAt !== null) return refuse('key_revoked');

  const descriptor: ApprovalDescriptor = {
    v: 1,
    actor: input.presenter.name,
    act: input.act,
    target: input.target,
    payload_digest: payloadDigest(input.payload),
    audience: input.audience,
    expiry: Number(nonce.expires_at),
    nonce: proof.nonce,
  };
  if (payloadDigest(descriptorSigningBytes(descriptor)) !== nonce.descriptor_digest) {
    return refuse('descriptor_mismatch');
  }
  let valid = false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.from(key.publicKey, 'base64url'),
      format: 'der',
      type: 'spki',
    });
    valid = cryptoVerify(
      null,
      Buffer.from(descriptorSigningBytes(descriptor), 'utf8'),
      publicKey,
      Buffer.from(proof.signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return refuse('descriptor_mismatch');

  await db.run(`UPDATE approval_nonces SET used_at = ? WHERE nonce = ?`, [now, proof.nonce]);
  await appendAudit(db, input.teamId, {
    actor: input.presenter.name,
    action: 'authority.approved',
    target: input.target,
    result: 'allow',
    detail: { act: input.act, assurance: 'A2', key_id: key.id, kind: key.kind },
  });
  return { ok: true, assurance: 'A2', keyId: key.id, kind: key.kind };
}
