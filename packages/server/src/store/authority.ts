import { createHash, createPublicKey, randomBytes, verify as cryptoVerify } from 'node:crypto';
import {
  descriptorSigningBytes,
  isHighAuthorityAct,
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
import { extractAuthData, verifyAssertion, verifyRegistration } from './webauthn.js';

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
  /** Passkeys only: the WebAuthn credential id (base64url) this key answers to. */
  credentialId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

interface DeviceKeyRow {
  id: string;
  member_id: string;
  public_key: string;
  kind: string;
  credential_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

const toKey = (r: DeviceKeyRow): DeviceKey => ({
  id: r.id,
  memberId: r.member_id,
  publicKey: r.public_key,
  kind: r.kind as AuthenticatorKind,
  credentialId: r.credential_id,
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
    credentialId?: string | null;
    now?: number;
  },
): Promise<DeviceKey> {
  const now = input.now ?? Date.now();
  const key: DeviceKey = {
    id: ulid(now),
    memberId: input.memberId,
    publicKey: input.publicKey,
    kind: input.kind,
    credentialId: input.credentialId ?? null,
    createdAt: now,
    revokedAt: null,
  };
  await db.run(
    `INSERT INTO device_keys (id, team_id, member_id, public_key, kind, credential_id, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    [key.id, input.teamId, key.memberId, key.publicKey, key.kind, key.credentialId, now],
  );
  return key;
}

export async function listDeviceKeys(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<DeviceKey[]> {
  const rows = await db.all<DeviceKeyRow>(
    `SELECT id, member_id, public_key, kind, credential_id, created_at, revoked_at FROM device_keys
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
    `SELECT id, member_id, public_key, kind, credential_id, created_at, revoked_at FROM device_keys
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

const ENROLLMENT_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Mint the challenge for a passkey enrollment ceremony (decision 6, passkey-first —
 * nick 2026-10-20). Only the sha256 is stored; ten minutes, one use, never audited.
 * The challenge is NOT a capability: holding the human's Bearer [REDACTED] an agent can read
 * gets an attacker this challenge but enrolls nothing — enrollment completes only
 * with a user-verified WebAuthn registration (first key / recovery), or, once a key
 * stands, with a standing key's `device_key_admin` signature. HA2 re-review: the old
 * code path let whoever held the Bearer [REDACTED] a key outright, which is the exact
 * config.json attack decision 6 forbids.
 */
export async function issueEnrollmentChallenge(
  db: Driver,
  input: {
    teamId: string;
    memberId: string;
    actor: string;
    nodeId?: string;
    ceremonyOrigin?: string;
    ceremonyRpId?: string;
    now?: number;
  },
): Promise<{ challenge: string; expiresAt: number }> {
  const now = input.now ?? Date.now();
  const challenge = randomBytes(32).toString('base64url');
  const codeHash = createHash('sha256').update(challenge, 'utf8').digest('hex');
  await db.run(
    `INSERT INTO enrollment_codes
       (code_hash, team_id, member_id, expires_at, used_at, node_id, ceremony_origin, ceremony_rp_id)
     VALUES (?, ?, ?, ?, NULL, ?, ?, ?)`,
    [
      codeHash,
      input.teamId,
      input.memberId,
      now + ENROLLMENT_CODE_TTL_MS,
      input.nodeId ?? null,
      input.ceremonyOrigin ?? null,
      input.ceremonyRpId ?? null,
    ],
  );
  await appendAudit(db, input.teamId, {
    actor: input.actor,
    action: 'device_key.enrollment_challenge',
    target: input.actor,
    result: 'allow',
    detail: {},
  });
  return { challenge, expiresAt: now + ENROLLMENT_CODE_TTL_MS };
}

/** Spend a ceremony challenge: valid, unused, unexpired, and this member's. One use. */
export async function consumeEnrollmentChallenge(
  db: Driver,
  input: {
    teamId: string;
    memberId: string;
    challenge: string;
    nodeId?: string;
    ceremonyOrigin?: string;
    ceremonyRpId?: string;
    now?: number;
  },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const codeHash = createHash('sha256').update(input.challenge, 'utf8').digest('hex');
  const spent = await db.run(
    `UPDATE enrollment_codes SET used_at = ?
      WHERE team_id = ? AND code_hash = ? AND member_id = ? AND used_at IS NULL AND expires_at >= ?
        AND node_id IS ? AND ceremony_origin IS ? AND ceremony_rp_id IS ?`,
    [
      now,
      input.teamId,
      codeHash,
      input.memberId,
      now,
      input.nodeId ?? null,
      input.ceremonyOrigin ?? null,
      input.ceremonyRpId ?? null,
    ],
  );
  return spent.changes > 0;
}

export type EnrollKeyResult =
  | { ok: true; key: DeviceKey; via: 'ceremony' | 'approval' }
  | { ok: false; reason: string };

/**
 * Enroll a raw-public-key device key for a human (decision 6: a new key never authorizes
 * itself, and no key can be enrolled from an agent process). The FIRST key is always a
 * passkey from the browser ceremony ({@link enrollPasskeyGuarded}) — with zero active
 * keys this path refuses `passkey_first`, so a Bearer [REDACTED] agent can read can never
 * enroll a key it controls. Once a key stands, a further key is authorized by an A2
 * signature from a standing key over `device_key_admin`.
 */
export async function enrollKeyGuarded(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    member: { id: string; name: string; kind: string };
    publicKey: string;
    kind: AuthenticatorKind;
    proof?: ApprovalProof | undefined;
    expectedOrigins?: readonly string[] | undefined;
    expectedNodeId?: string | undefined;
    ceremonyOrigin?: string | undefined;
    now?: number;
  },
): Promise<EnrollKeyResult> {
  const now = input.now ?? Date.now();
  if (input.member.kind !== 'human') {
    await appendAudit(db, input.teamId, {
      actor: input.member.name,
      action: 'authority.refused',
      target: input.member.name,
      result: 'deny',
      detail: { act: 'device_key_admin', reason: 'agent_credential' },
    });
    return { ok: false, reason: 'agent_credential' };
  }
  const active = await activeDeviceKeys(db, input.teamId, input.member.id);
  if (active.length === 0) return { ok: false, reason: 'passkey_first' };
  const check = await requireAuthority(db, {
    teamId: input.teamId,
    audience: input.audience,
    presenter: input.member,
    credential: 'human',
    act: 'device_key_admin',
    target: input.member.name,
    payload: { action: 'enroll', public_key: input.publicKey, kind: input.kind },
    proof: input.proof,
    expectedOrigins: input.expectedOrigins,
    expectedNodeId: input.expectedNodeId,
    now,
  });
  if (!check.ok) return { ok: false, reason: check.reason };
  const key = await enrollDeviceKey(db, {
    teamId: input.teamId,
    memberId: input.member.id,
    publicKey: input.publicKey,
    kind: input.kind,
    now,
  });
  await appendAudit(db, input.teamId, {
    actor: input.member.name,
    action: 'device_key.enrolled',
    target: input.member.name,
    result: 'allow',
    detail: { key_id: key.id, kind: key.kind, via: 'approval' },
  });
  return { ok: true, key, via: 'approval' };
}

/**
 * Revoke one of a human's keys by an A2 signature from a standing key (decision 6).
 * A key never revokes itself while another stands; the sole standing key may retire
 * itself, which is the lost-device path — enrollment stays latched (lane 1), and
 * recovery is a fresh passkey ceremony, never a Bearer-only code.
 */
export async function revokeKeyGuarded(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    member: { id: string; name: string; kind: string };
    keyId: string;
    proof?: ApprovalProof | undefined;
    expectedOrigins?: readonly string[] | undefined;
    expectedNodeId?: string | undefined;
    now?: number;
  },
): Promise<{ ok: true; via: 'approval' } | { ok: false; reason: string }> {
  const now = input.now ?? Date.now();
  const key = await getDeviceKey(db, input.teamId, input.keyId);
  if (!key || key.memberId !== input.member.id) return { ok: false, reason: 'not_found' };
  if (key.revokedAt !== null) return { ok: false, reason: 'key_revoked' };
  if (input.proof?.key_id === input.keyId) {
    const others = (await activeDeviceKeys(db, input.teamId, input.member.id)).filter(
      (k) => k.id !== input.keyId,
    );
    if (others.length > 0) {
      await appendAudit(db, input.teamId, {
        actor: input.member.name,
        action: 'authority.refused',
        target: input.member.name,
        result: 'deny',
        detail: { act: 'device_key_admin', reason: 'descriptor_mismatch', key_id: input.keyId },
      });
      return { ok: false, reason: 'descriptor_mismatch' };
    }
  }
  const check = await requireAuthority(db, {
    teamId: input.teamId,
    audience: input.audience,
    presenter: input.member,
    credential: input.member.kind === 'human' ? 'human' : 'agent',
    act: 'device_key_admin',
    target: input.member.name,
    payload: { action: 'revoke', key_id: input.keyId },
    proof: input.proof,
    expectedOrigins: input.expectedOrigins,
    expectedNodeId: input.expectedNodeId,
    now,
  });
  if (!check.ok) return { ok: false, reason: check.reason };
  await revokeDeviceKey(db, input.teamId, input.keyId, now);
  await appendAudit(db, input.teamId, {
    actor: input.member.name,
    action: 'device_key.revoked',
    target: input.member.name,
    result: 'allow',
    detail: { key_id: input.keyId, via: 'approval' },
  });
  return { ok: true, via: 'approval' };
}

interface NonceRow {
  nonce: string;
  member_id: string;
  descriptor_digest: string;
  expires_at: number;
  used_at: number | null;
  node_id: string | null;
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
    nodeId?: string;
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
    `INSERT INTO approval_nonces
       (nonce, team_id, member_id, descriptor_digest, expires_at, used_at, actor, act, target, payload_digest, node_id)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`,
    [
      descriptor.nonce,
      input.teamId,
      input.memberId,
      payloadDigest(descriptorSigningBytes(descriptor)),
      descriptor.expiry,
      descriptor.actor,
      descriptor.act,
      descriptor.target,
      descriptor.payload_digest,
      input.nodeId ?? null,
    ],
  );
  return descriptor;
}

/**
 * What the server built for one nonce — what the daemon's approval page renders (decision 5:
 * from server data, never caller wording). Null once the nonce is spent or expired.
 */
export async function getDescriptorByNonce(
  db: Driver,
  teamId: string,
  audience: string,
  nonce: string,
  now = Date.now(),
  nodeId?: string,
): Promise<ApprovalDescriptor | null> {
  const row = await db.get<{
    member_id: string;
    actor: string | null;
    act: string | null;
    target: string | null;
    payload_digest: string | null;
    expires_at: number;
    used_at: number | null;
    node_id: string | null;
  }>(
    `SELECT member_id, actor, act, target, payload_digest, expires_at, used_at, node_id
       FROM approval_nonces WHERE team_id = ? AND nonce = ?`,
    [teamId, nonce],
  );
  if (!row || row.used_at !== null || now > Number(row.expires_at)) return null;
  if (nodeId !== undefined && row.node_id !== nodeId) return null;
  if (!row.actor || !row.act || !row.target || !row.payload_digest) return null;
  if (!isHighAuthorityAct(row.act)) return null;
  return {
    v: 1,
    actor: row.actor,
    act: row.act,
    target: row.target,
    payload_digest: row.payload_digest,
    audience,
    expiry: Number(row.expires_at),
    nonce,
  };
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
    /** ADR 662 dec. 5: passkey ceremonies must be on one of these origins, when known. */
    expectedOrigins?: readonly string[] | undefined;
    /** ADR 728: a forwarded ceremony nonce must have been created for this authenticated node. */
    expectedNodeId?: string | undefined;
    /**
     * Run every check and stop before the spend (ADR 694): the nonce stays live and no approval
     * is audited; a refusal is audited as usual. For a caller that must not write the act it
     * carries until it knows the gate will take it — the app channel's verdict, which the act
     * path then presents for real.
     */
    checkOnly?: boolean;
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
    `SELECT nonce, member_id, descriptor_digest, expires_at, used_at, node_id FROM approval_nonces
      WHERE team_id = ? AND nonce = ?`,
    [input.teamId, proof.nonce],
  );
  if (!nonce || nonce.member_id !== input.presenter.id) return refuse('descriptor_mismatch');
  if (input.expectedNodeId !== undefined && nonce.node_id !== input.expectedNodeId)
    return refuse('descriptor_mismatch');
  if (nonce.used_at !== null) return refuse('nonce_reused');
  if (now > Number(nonce.expires_at)) return refuse('expired');

  const key = await getDeviceKey(db, input.teamId, proof.key_id);
  if (!key || key.memberId !== input.presenter.id) return refuse('descriptor_mismatch');
  if (key.revokedAt !== null) return refuse('key_revoked');
  // Decision 5: a software key's private half is readable by any same-user process,
  // so it never qualifies as A2 — however valid its signature is.
  if (key.kind === 'software') return refuse('assurance_too_low');

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
  if (key.kind === 'passkey') {
    // A passkey never signs our bytes: it signs an assertion whose challenge is the nonce.
    valid =
      proof.authenticator_data !== undefined &&
      proof.client_data_json !== undefined &&
      verifyAssertion({
        authenticatorData: Buffer.from(proof.authenticator_data, 'base64url'),
        clientDataJson: proof.client_data_json,
        signature: Buffer.from(proof.signature, 'base64url'),
        publicKeySpki: key.publicKey,
        expectedChallenge: proof.nonce,
        expectedOrigins: input.expectedOrigins,
      });
  } else {
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
  }
  if (!valid) return refuse('descriptor_mismatch');
  if (input.checkOnly) return { ok: true, assurance: 'A2', keyId: key.id, kind: key.kind };

  // One-use, atomically: the conditional update is the consumption, so two concurrent
  // presentations of the same proof cannot both spend the nonce (HA1 re-review).
  const spent = await db.run(
    `UPDATE approval_nonces SET used_at = ? WHERE team_id = ? AND nonce = ? AND used_at IS NULL`,
    [now, input.teamId, proof.nonce],
  );
  if (spent.changes === 0) return refuse('nonce_reused');
  await appendAudit(db, input.teamId, {
    actor: input.presenter.name,
    action: 'authority.approved',
    target: input.target,
    result: 'allow',
    detail: { act: input.act, assurance: 'A2', key_id: key.id, kind: key.kind },
  });
  return { ok: true, assurance: 'A2', keyId: key.id, kind: key.kind };
}

/**
 * Park a verified passkey proof on its nonce row for the waiting surface to collect. The
 * signature is verified HERE, against the stored descriptor and the enrolled credential —
 * parking never grants anything; the act re-verifies at presentation.
 */
export async function storePasskeyProof(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    proof: ApprovalProof;
    /** ADR 662 dec. 5: the ceremony must be on one of these origins (the daemon's own). */
    expectedOrigins?: readonly string[] | undefined;
    expectedNodeId?: string | undefined;
    now?: number;
  },
): Promise<boolean> {
  const descriptor = await getDescriptorByNonce(
    db,
    input.teamId,
    input.audience,
    input.proof.nonce,
    input.now ?? Date.now(),
    input.expectedNodeId,
  );
  if (!descriptor) return false;
  const key = await getDeviceKey(db, input.teamId, input.proof.key_id);
  if (!key || key.kind !== 'passkey' || key.revokedAt !== null) return false;
  if (
    input.proof.authenticator_data === undefined ||
    input.proof.client_data_json === undefined ||
    !verifyAssertion({
      authenticatorData: Buffer.from(input.proof.authenticator_data, 'base64url'),
      clientDataJson: input.proof.client_data_json,
      signature: Buffer.from(input.proof.signature, 'base64url'),
      publicKeySpki: key.publicKey,
      expectedChallenge: input.proof.nonce,
      expectedOrigins: input.expectedOrigins,
    })
  ) {
    return false;
  }
  await db.run(
    `UPDATE approval_nonces
        SET proof_key_id = ?, proof_signature = ?, proof_authenticator_data = ?, proof_client_data_json = ?
      WHERE team_id = ? AND nonce = ?`,
    [
      input.proof.key_id,
      input.proof.signature,
      input.proof.authenticator_data,
      input.proof.client_data_json,
      input.teamId,
      input.proof.nonce,
    ],
  );
  return true;
}

/** The enrolled passkeys a descriptor's human can approve it with (page allow-list). */
export async function getPasskeysForDescriptor(
  db: Driver,
  teamId: string,
  nonce: string,
): Promise<{ key_id: string; credential_id: string }[]> {
  const row = await db.get<{ member_id: string }>(
    `SELECT member_id FROM approval_nonces WHERE team_id = ? AND nonce = ?`,
    [teamId, nonce],
  );
  if (!row) return [];
  const keys = await activeDeviceKeys(db, teamId, row.member_id);
  return keys
    .filter((k) => k.kind === 'passkey' && k.credentialId !== null)
    .map((k) => ({ key_id: k.id, credential_id: k.credentialId! }));
}

/** The parked proof for a nonce, once the human has approved on the passkey page. */
export async function getParkedProof(
  db: Driver,
  teamId: string,
  nonce: string,
): Promise<ApprovalProof | null> {
  const row = await db.get<{
    proof_key_id: string | null;
    proof_signature: string | null;
    proof_authenticator_data: string | null;
    proof_client_data_json: string | null;
  }>(
    `SELECT proof_key_id, proof_signature, proof_authenticator_data, proof_client_data_json
       FROM approval_nonces WHERE team_id = ? AND nonce = ?`,
    [teamId, nonce],
  );
  if (!row?.proof_key_id || !row.proof_signature) return null;
  return {
    key_id: row.proof_key_id,
    nonce,
    signature: row.proof_signature,
    ...(row.proof_authenticator_data ? { authenticator_data: row.proof_authenticator_data } : {}),
    ...(row.proof_client_data_json ? { client_data_json: row.proof_client_data_json } : {}),
  };
}

/**
 * Enroll a passkey (decision 6, passkey-first). The registration ceremony's challenge
 * is the server-minted enrollment challenge, so the challenge's one use and the
 * credential's birth are the same event.
 *
 * The zero-key anchor (nick, 2026-10-20): with no attestation checked, a fabricated
 * authenticator can complete a ceremony, so the ceremony alone anchors nothing once
 * the team has keys. While the TEAM has no device key at all, the genesis ceremony
 * stands alone — that window exists only at team birth. After that, a member with
 * zero active keys (first enrollment, or lost-everything recovery) needs a countersign:
 * a DIFFERENT human admin of the team, with a standing key, signing `device_key_admin`
 * over `{action:'enroll', kind:'passkey', member}`. No countersigner, no recovery —
 * fail closed. Once the member has a standing key, a further passkey needs their own.
 */
export async function enrollPasskeyGuarded(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    member: { id: string; name: string; kind: string };
    challenge: string;
    registration: { attestationObject: Uint8Array; clientDataJson: string };
    proof?: ApprovalProof | undefined;
    /** Another human admin's standing-key signature, for the zero-active-key path. */
    countersign?:
      | {
          confirmer: { id: string; name: string; kind: string };
          isAdmin: boolean;
          proof?: ApprovalProof | undefined;
        }
      | undefined;
    /** ADR 662 dec. 5: the ceremony must be on one of these origins (the daemon's own). */
    expectedOrigins?: readonly string[] | undefined;
    expectedRpId?: string | undefined;
    expectedNodeId?: string | undefined;
    ceremonyOrigin?: string | undefined;
    countersignExpectedOrigins?: readonly string[] | undefined;
    now?: number;
  },
): Promise<EnrollKeyResult> {
  const now = input.now ?? Date.now();
  if (input.member.kind !== 'human') return { ok: false, reason: 'agent_credential' };
  let verified: { credentialId: string; publicKeySpki: string };
  try {
    verified = verifyRegistration({
      authenticatorData: extractAuthData(input.registration.attestationObject),
      clientDataJson: input.registration.clientDataJson,
      expectedChallenge: input.challenge,
      requireUserVerified: true,
      expectedOrigins: input.expectedOrigins,
      expectedRpId: input.expectedRpId,
    });
  } catch {
    return { ok: false, reason: 'bad_registration' };
  }
  const active = await activeDeviceKeys(db, input.teamId, input.member.id);
  if (active.length > 0) {
    const check = await requireAuthority(db, {
      teamId: input.teamId,
      audience: input.audience,
      presenter: input.member,
      credential: 'human',
      act: 'device_key_admin',
      target: input.member.name,
      payload: { action: 'enroll', kind: 'passkey' },
      proof: input.proof,
      expectedOrigins: input.expectedOrigins,
      expectedNodeId: input.expectedNodeId,
      now,
    });
    if (!check.ok) return { ok: false, reason: check.reason };
  } else {
    // Zero active keys for this member: genesis (team has no key at all) stands
    // alone; otherwise another human admin's standing key must countersign.
    const anyTeamKey = await db.get<{ id: string }>(
      `SELECT id FROM device_keys WHERE team_id = ? LIMIT 1`,
      [input.teamId],
    );
    if (anyTeamKey) {
      const cs = input.countersign;
      if (
        !cs ||
        cs.confirmer.kind !== 'human' ||
        !cs.isAdmin ||
        cs.confirmer.id === input.member.id
      ) {
        return { ok: false, reason: 'countersign_required' };
      }
      const check = await requireAuthority(db, {
        teamId: input.teamId,
        audience: input.audience,
        presenter: cs.confirmer,
        credential: 'human',
        act: 'device_key_admin',
        target: input.member.name,
        payload: { action: 'enroll', kind: 'passkey', member: input.member.name },
        proof: cs.proof,
        expectedOrigins: input.countersignExpectedOrigins ?? input.expectedOrigins,
        now,
      });
      if (!check.ok) return { ok: false, reason: check.reason };
    }
  }
  const spent = await consumeEnrollmentChallenge(db, {
    teamId: input.teamId,
    memberId: input.member.id,
    challenge: input.challenge,
    ...(input.expectedNodeId !== undefined ? { nodeId: input.expectedNodeId } : {}),
    ...(input.ceremonyOrigin !== undefined ? { ceremonyOrigin: input.ceremonyOrigin } : {}),
    ...(input.expectedRpId !== undefined ? { ceremonyRpId: input.expectedRpId } : {}),
    now,
  });
  if (!spent) return { ok: false, reason: 'bad_challenge' };
  const key = await enrollDeviceKey(db, {
    teamId: input.teamId,
    memberId: input.member.id,
    publicKey: verified.publicKeySpki,
    kind: 'passkey',
    credentialId: verified.credentialId,
    now,
  });
  await appendAudit(db, input.teamId, {
    actor: input.member.name,
    action: 'device_key.enrolled',
    target: input.member.name,
    result: 'allow',
    detail: { key_id: key.id, kind: 'passkey', via: 'ceremony' },
  });
  return { ok: true, key, via: 'ceremony' };
}
