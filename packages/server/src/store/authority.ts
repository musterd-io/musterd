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
import { phoneKeyPairingEnded } from './appPairing.js';
import { appendAudit } from './audit.js';
import { getMemberByName, listMembers } from './members.js';
import { resolveCapabilities } from './rows.js';
import {
  assertionFailure,
  extractAuthData,
  verifyAssertion,
  verifyRegistration,
} from './webauthn.js';

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
  /** ADR 808: where the key was made — the registration's origin, or `app` for a phone key.
   *  Null on a key enrolled before this was recorded. */
  origin: string | null;
  /** ADR 808: the relying-party id a passkey is bound to (the origin's hostname); null when
   *  unrecorded or not a passkey. A surface compares it with its own hostname. */
  rpId: string | null;
  createdAt: number;
  revokedAt: number | null;
}

interface DeviceKeyRow {
  id: string;
  member_id: string;
  public_key: string;
  kind: string;
  credential_id: string | null;
  origin: string | null;
  rp_id: string | null;
  created_at: number;
  revoked_at: number | null;
}

const toKey = (r: DeviceKeyRow): DeviceKey => ({
  id: r.id,
  memberId: r.member_id,
  publicKey: r.public_key,
  kind: r.kind as AuthenticatorKind,
  credentialId: r.credential_id,
  origin: r.origin ?? null,
  rpId: r.rp_id ?? null,
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
    /** ADR 808: the origin the key was made on; `app` for a phone key. */
    origin?: string | null;
    /** ADR 808: the passkey's relying-party id; omitted when not a passkey. */
    rpId?: string | null;
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
    origin: input.origin ?? null,
    rpId: input.rpId ?? null,
    createdAt: now,
    revokedAt: null,
  };
  await db.run(
    `INSERT INTO device_keys (id, team_id, member_id, public_key, kind, credential_id, origin, rp_id, created_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    [
      key.id,
      input.teamId,
      key.memberId,
      key.publicKey,
      key.kind,
      key.credentialId,
      key.origin,
      key.rpId,
      now,
    ],
  );
  return key;
}

/** ADR 808: the origin a WebAuthn registration was made on, and its relying-party id, read from
 *  the client data the verifier already checked. Null when the text is not what a browser sends. */
export function registrationOrigin(clientDataJson: string): {
  origin: string | null;
  rpId: string | null;
} {
  try {
    const origin = (JSON.parse(clientDataJson) as { origin?: unknown }).origin;
    if (typeof origin !== 'string') return { origin: null, rpId: null };
    return { origin, rpId: new URL(origin).hostname };
  } catch {
    return { origin: null, rpId: null };
  }
}

export async function listDeviceKeys(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<DeviceKey[]> {
  const rows = await db.all<DeviceKeyRow>(
    `SELECT id, member_id, public_key, kind, credential_id, origin, rp_id, created_at, revoked_at FROM device_keys
      WHERE team_id = ? AND member_id = ? ORDER BY created_at`,
    [teamId, memberId],
  );
  return rows.map(toKey);
}

/** The member's keys that can still sign: enrolled and not revoked. */
/** A phone key whose pairing was superseded or revoked. A key with no binding row (test fixtures,
 *  pre-pairing enrollments) is left as it was: the lifecycle this closes is the pairing's. */
export async function pairingOver(db: Driver, teamId: string, keyId: string): Promise<boolean> {
  const ended = await phoneKeyPairingEnded(db, teamId, keyId);
  return ended === 'superseded' || ended === 'revoked';
}

export async function activeDeviceKeys(
  db: Driver,
  teamId: string,
  memberId: string,
): Promise<DeviceKey[]> {
  const live = (await listDeviceKeys(db, teamId, memberId)).filter((k) => k.revokedAt === null);
  // Lane 01M6Q1RDTK: a phone key whose pairing has ended is not standing authority, whether or
  // not the sweep has caught up with it — derived here, where "usable key stands" is decided.
  const out: DeviceKey[] = [];
  for (const k of live) {
    if (k.kind === 'phone' && (await pairingOver(db, teamId, k.id))) continue;
    out.push(k);
  }
  return out;
}

export async function getDeviceKey(
  db: Driver,
  teamId: string,
  keyId: string,
): Promise<DeviceKey | null> {
  const row = await db.get<DeviceKeyRow>(
    `SELECT id, member_id, public_key, kind, credential_id, origin, rp_id, created_at, revoked_at FROM device_keys
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

const RECOVERY_CODE_TTL_MS = 5 * 60 * 1000;

/**
 * ADR 808 inc D: does any of this member's active keys sign somewhere the hub serves? A phone key
 * signs from the app; a passkey signs on its relying party, which must be one of the hub's
 * configured passkey hostnames — and a passkey from before origins were recorded (`rpId` null)
 * is taken as usable, never as lost. Only when this is false may a recovery code be minted.
 */
export function usableKeyStands(keys: readonly DeviceKey[], hosts: readonly string[]): boolean {
  return keys.some(
    (k) =>
      k.revokedAt === null &&
      (k.kind === 'phone' ||
        k.kind === 'platform' ||
        (k.kind === 'passkey' && k.rpId !== null && hosts.includes(k.rpId))),
  );
}

/**
 * ADR 808 inc D: is there ANOTHER human admin whose key is known to sign here? Then the fail-closed
 * countersign of ADR 662 still applies and no recovery code is minted: the admin vouches, as the
 * rule always said. The code is only for a team with nobody left who can.
 */
export async function recoveryCountersignerStands(
  db: Driver,
  teamId: string,
  memberId: string,
  hosts: readonly string[],
): Promise<string | null> {
  const members = await listMembers(db, teamId);
  for (const m of members) {
    if (m.id === memberId || m.kind !== 'human' || !resolveCapabilities(m).is_admin) continue;
    // Lane 01M6Q1RDTK: a phone key whose pairing ended is not a usable key, here as at the spend.
    if (usableKeyStands(await activeDeviceKeys(db, teamId, m.id), hosts)) return m.name;
  }
  return null;
}

/**
 * ADR 769: every human admin who could vouch for this member now — a different human, admin, with
 * a key that signs where the hub serves. The same rule as {@link recoveryCountersignerStands},
 * listed in full so the member's sheet offers only admins whose vouch could be signed.
 */
export async function countersignersFor(
  db: Driver,
  teamId: string,
  memberId: string,
  hosts: readonly string[],
): Promise<string[]> {
  const out: string[] = [];
  for (const m of await listMembers(db, teamId)) {
    if (m.id === memberId || m.kind !== 'human' || m.left_at !== null) continue;
    if (!resolveCapabilities(m).is_admin) continue;
    if (usableKeyStands(await activeDeviceKeys(db, teamId, m.id), hosts)) out.push(m.name);
  }
  return out;
}

/**
 * ADR 808 inc D: mint a one-time passkey recovery code for a member whose every key is bound to an
 * origin this hub no longer serves. The caller has already established that it runs on the hub's
 * own machine (the route's loopback check) — the same trust `node join` carries. Five minutes, one
 * live code per member, sha256 stored, audited with the operator's OS user. The code is an
 * enrollment challenge: the registration that spends it (`enrollPasskeyGuarded`) needs no
 * standing-key approval and no admin countersign, but re-checks that no usable key stands.
 */
export async function issueRecoveryCode(
  db: Driver,
  input: {
    teamId: string;
    member: { id: string; name: string; kind: string };
    issuedBy: string;
    hosts: readonly string[];
    now?: number;
  },
): Promise<
  | { ok: true; code: string; expiresAt: number }
  | {
      ok: false;
      reason: 'agent_member' | 'usable_key_stands' | 'countersigner_stands' | 'recovery_live';
      countersigner?: string;
    }
> {
  const now = input.now ?? Date.now();
  if (input.member.kind !== 'human') return { ok: false, reason: 'agent_member' };
  const keys = await activeDeviceKeys(db, input.teamId, input.member.id);
  if (usableKeyStands(keys, input.hosts)) return { ok: false, reason: 'usable_key_stands' };
  const countersigner = await recoveryCountersignerStands(
    db,
    input.teamId,
    input.member.id,
    input.hosts,
  );
  if (countersigner) return { ok: false, reason: 'countersigner_stands', countersigner };
  const live = await db.get<{ code_hash: string }>(
    `SELECT code_hash FROM enrollment_codes
      WHERE team_id = ? AND member_id = ? AND recovery = 1 AND used_at IS NULL AND expires_at >= ?`,
    [input.teamId, input.member.id, now],
  );
  if (live) return { ok: false, reason: 'recovery_live' };
  const code = randomBytes(24).toString('base64url');
  const codeHash = createHash('sha256').update(code, 'utf8').digest('hex');
  const expiresAt = now + RECOVERY_CODE_TTL_MS;
  await db.run(
    `INSERT INTO enrollment_codes
       (code_hash, team_id, member_id, expires_at, used_at, node_id, ceremony_origin, ceremony_rp_id, recovery, issued_by)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, 1, ?)`,
    [codeHash, input.teamId, input.member.id, expiresAt, input.issuedBy],
  );
  await appendAudit(db, input.teamId, {
    actor: input.member.name,
    action: 'device_key.recovery_code',
    target: input.member.name,
    result: 'allow',
    // `claimed_by` is what the caller typed about themself; the proof of who they are is the
    // daemon's own recovery secret, readable only by the daemon's OS user (the route checks it).
    detail: { claimed_by: input.issuedBy, expires_at: expiresAt, proof: 'operator_secret' },
  });
  return { ok: true, code, expiresAt };
}

/** Is this challenge a live recovery code of this member's (ADR 808 inc D)? Read, not spent. */
export async function recoveryChallengeStands(
  db: Driver,
  teamId: string,
  memberId: string,
  challenge: string,
  now: number,
): Promise<boolean> {
  const codeHash = createHash('sha256').update(challenge, 'utf8').digest('hex');
  const row = await db.get<{ code_hash: string }>(
    `SELECT code_hash FROM enrollment_codes
      WHERE team_id = ? AND code_hash = ? AND member_id = ? AND recovery = 1 AND used_at IS NULL AND expires_at >= ?`,
    [teamId, codeHash, memberId, now],
  );
  return row !== undefined && row !== null;
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
  | { ok: true; key: DeviceKey; via: 'ceremony' | 'approval' | 'recovery' | 'vouch' }
  | {
      ok: false;
      reason: string;
      /** ADR 769: the registration verified and is held for an admin's vouch. */
      held?: { enrollmentDigest: string; expiresAt: number };
    };

/**
 * ADR 769: the identity of a held enrollment, and the digest an admin's vouch signs. Every field
 * that could be swapped after the admin looked is in it: team, member, the enrollment code it
 * spends, the credential id, the public key, and the origin and relying party it was made on.
 */
export interface HeldEnrollmentFields {
  teamId: string;
  memberId: string;
  codeHash: string;
  credentialId: string;
  publicKey: string;
  origin: string | null;
  rpId: string | null;
}

export function heldEnrollmentDigest(f: HeldEnrollmentFields): string {
  return payloadDigest({
    team: f.teamId,
    member: f.memberId,
    challenge_hash: f.codeHash,
    credential_id: f.credentialId,
    spki: f.publicKey,
    origin: f.origin,
    rp_id: f.rpId,
  });
}

/**
 * ADR 769: hold a verified registration against its live enrollment code, for an admin to vouch.
 * Written once: a second hold of the same registration returns the same digest, a different
 * registration on the same code is refused. Nothing is enrolled and the code is not spent.
 */
async function holdEnrollment(
  db: Driver,
  f: HeldEnrollmentFields,
  binding: { nodeId: string | null; ceremonyOrigin: string | null; ceremonyRpId: string | null },
  now: number,
): Promise<
  { ok: true; enrollmentDigest: string; expiresAt: number } | { ok: false; reason: string }
> {
  const code = await db.get<{ expires_at: number }>(
    `SELECT expires_at FROM enrollment_codes
      WHERE team_id = ? AND code_hash = ? AND member_id = ? AND used_at IS NULL AND expires_at >= ?
        AND node_id IS ? AND ceremony_origin IS ? AND ceremony_rp_id IS ?`,
    [
      f.teamId,
      f.codeHash,
      f.memberId,
      now,
      binding.nodeId,
      binding.ceremonyOrigin,
      binding.ceremonyRpId,
    ],
  );
  if (!code) return { ok: false, reason: 'bad_challenge' };
  const digest = heldEnrollmentDigest(f);
  await db.run(
    `INSERT INTO held_enrollments
       (code_hash, team_id, member_id, credential_id, public_key, origin, rp_id, digest, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (code_hash) DO NOTHING`,
    [f.codeHash, f.teamId, f.memberId, f.credentialId, f.publicKey, f.origin, f.rpId, digest, now],
  );
  const held = await db.get<{ digest: string }>(
    `SELECT digest FROM held_enrollments WHERE team_id = ? AND code_hash = ?`,
    [f.teamId, f.codeHash],
  );
  if (held?.digest !== digest) return { ok: false, reason: 'already_held' };
  return { ok: true, enrollmentDigest: digest, expiresAt: Number(code.expires_at) };
}

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
    // ADR 808: a phone key is made in the app, not on a web origin.
    ...(input.kind === 'phone' ? { origin: 'app' } : {}),
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
  | { ok: false; reason: AuthorityRefusalReason; why?: string };

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
  // `why` names the check that failed, for the audit and the person (lane 01M6EPWAJP): four checks
  // share the `descriptor_mismatch` reason, and a human refused on /live could not tell a stale
  // nonce from a signature over the wrong ask. The reason stays the contract; the sentence is detail.
  const refuse = async (reason: AuthorityRefusalReason, why?: string): Promise<AuthorityCheck> => {
    await appendAudit(db, input.teamId, {
      actor: input.presenter.name,
      action: 'authority.refused',
      target: input.target,
      result: 'deny',
      detail: {
        act: input.act,
        reason,
        ...(why ? { why } : {}),
        ...(input.proof ? { key_id: input.proof.key_id } : {}),
      },
    });
    return { ok: false, reason, ...(why ? { why } : {}) };
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
  if (!nonce)
    return refuse(
      'descriptor_mismatch',
      'no live descriptor for that nonce (used, expired, or minted elsewhere)',
    );
  if (nonce.member_id !== input.presenter.id)
    return refuse(
      'descriptor_mismatch',
      `the descriptor was minted for another member, not ${input.presenter.name}`,
    );
  if (input.expectedNodeId !== undefined && nonce.node_id !== input.expectedNodeId)
    return refuse('descriptor_mismatch', 'the descriptor was minted on another node');
  if (nonce.used_at !== null) return refuse('nonce_reused');
  if (now > Number(nonce.expires_at)) return refuse('expired');

  const key = await getDeviceKey(db, input.teamId, proof.key_id);
  if (!key || key.memberId !== input.presenter.id)
    return refuse('descriptor_mismatch', `the signing key is not ${input.presenter.name}'s`);
  if (key.revokedAt !== null) return refuse('key_revoked');
  // Lane 01M6Q1RDTK: a phone key signs only while its pairing stands. A superseded pairing is a
  // derived fact (the daemon key changed), so it is checked here, at the spend, not left to a sweep.
  if (key.kind === 'phone' && (await pairingOver(db, input.teamId, key.id)))
    return refuse('key_revoked');
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
    return refuse(
      'descriptor_mismatch',
      `the signature covers a different act, target or payload (expected ${descriptor.act} on ${descriptor.target})`,
    );
  }
  let why: string | null = null;
  if (key.kind === 'passkey') {
    // A passkey never signs our bytes: it signs an assertion whose challenge is the nonce.
    if (proof.authenticator_data === undefined || proof.client_data_json === undefined) {
      why =
        'the proof carries no passkey assertion (authenticator data and client data are required)';
    } else {
      why = assertionFailure({
        authenticatorData: Buffer.from(proof.authenticator_data, 'base64url'),
        clientDataJson: proof.client_data_json,
        signature: Buffer.from(proof.signature, 'base64url'),
        publicKeySpki: key.publicKey,
        expectedChallenge: proof.nonce,
        expectedOrigins: input.expectedOrigins,
      });
    }
  } else {
    try {
      const publicKey = createPublicKey({
        key: Buffer.from(key.publicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      });
      if (
        !cryptoVerify(
          null,
          Buffer.from(descriptorSigningBytes(descriptor), 'utf8'),
          publicKey,
          Buffer.from(proof.signature, 'base64url'),
        )
      )
        why = 'the signature does not verify against the enrolled key';
    } catch {
      why = 'the enrolled key or the signature could not be read';
    }
  }
  if (why !== null) return refuse('descriptor_mismatch', why);
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

/**
 * ADR 808 inc C: park a PHONE key's proof on its nonce row, verified here the way an app answer's
 * approval is (ECDSA P-256 / SHA-256 over the descriptor's signing bytes). Parking grants
 * nothing; the act re-verifies the same proof through `requireAuthority` when it is presented.
 * The key must be the human's own live phone key, and the descriptor theirs.
 */
export async function storePhoneProof(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    memberId: string;
    proof: ApprovalProof;
    now?: number;
  },
): Promise<boolean> {
  const now = input.now ?? Date.now();
  const descriptor = await getDescriptorByNonce(
    db,
    input.teamId,
    input.audience,
    input.proof.nonce,
    now,
  );
  if (!descriptor) return false;
  const owner = await db.get<{ member_id: string }>(
    `SELECT member_id FROM approval_nonces WHERE team_id = ? AND nonce = ?`,
    [input.teamId, input.proof.nonce],
  );
  if (!owner || owner.member_id !== input.memberId) return false;
  const key = await getDeviceKey(db, input.teamId, input.proof.key_id);
  if (!key || key.kind !== 'phone' || key.revokedAt !== null || key.memberId !== input.memberId)
    return false;
  let valid = false;
  try {
    valid = cryptoVerify(
      'sha256',
      Buffer.from(descriptorSigningBytes(descriptor), 'utf8'),
      createPublicKey({
        key: Buffer.from(key.publicKey, 'base64url'),
        format: 'der',
        type: 'spki',
      }),
      Buffer.from(input.proof.signature, 'base64url'),
    );
  } catch {
    valid = false;
  }
  if (!valid) return false;
  await db.run(
    `UPDATE approval_nonces SET proof_key_id = ?, proof_signature = ? WHERE team_id = ? AND nonce = ?`,
    [input.proof.key_id, input.proof.signature, input.teamId, input.proof.nonce],
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
    /** ADR 808 inc D: the hostnames of this hub's configured passkey origins, for the recovery
     *  re-check that no usable key stands; omitted, a recovery code is not honoured. ADR 769:
     *  the same hosts decide whether the member has a usable key (standing-key approval) or not
     *  (admin countersign); omitted, the countersign is read only at zero active keys. */
    recoveryHosts?: readonly string[] | undefined;
    /** ADR 769: with no countersign, hold the verified registration for an admin's vouch and
     *  return its digest instead of only refusing. Opt-in, so older clients see no change. */
    hold?: boolean | undefined;
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
  // ADR 808 inc D: a recovery code the hub's operator minted stands in for both the standing-key
  // approval and the admin countersign — only while no key of this member's signs anywhere the
  // hub serves, re-checked here at the moment of spending.
  const recovery =
    input.recoveryHosts !== undefined &&
    (await recoveryChallengeStands(db, input.teamId, input.member.id, input.challenge, now));
  if (recovery && usableKeyStands(active, input.recoveryHosts!)) {
    return { ok: false, reason: 'usable_key_stands' };
  }
  // …and re-checked: an admin who can countersign appeared since the mint, so the ADR 662 rule
  // applies again and the code is not enough.
  if (
    recovery &&
    (await recoveryCountersignerStands(db, input.teamId, input.member.id, input.recoveryHosts!))
  ) {
    return { ok: false, reason: 'countersign_required' };
  }
  // ADR 769: a member with no USABLE key (none that signs where this hub serves) cannot sign the
  // standing-key approval, so an admin's countersign is the path, not only at zero keys. Without
  // the hub's hosts, fall back to the zero-key rule.
  const hosts = input.recoveryHosts;
  const noUsableKey = hosts !== undefined ? !usableKeyStands(active, hosts) : active.length === 0;
  const codeHash = createHash('sha256').update(input.challenge, 'utf8').digest('hex');
  const made = registrationOrigin(input.registration.clientDataJson);
  const heldFields: HeldEnrollmentFields = {
    teamId: input.teamId,
    memberId: input.member.id,
    codeHash,
    credentialId: verified.credentialId,
    publicKey: verified.publicKeySpki,
    origin: made.origin,
    rpId: made.rpId,
  };
  if (recovery) {
    // nothing more to prove: the operator's loopback act is the authority (audited at mint)
  } else if (!noUsableKey) {
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
      if (!cs && input.hold) {
        const held = await holdEnrollment(
          db,
          heldFields,
          {
            nodeId: input.expectedNodeId ?? null,
            ceremonyOrigin: input.ceremonyOrigin ?? null,
            ceremonyRpId: input.expectedRpId ?? null,
          },
          now,
        );
        if (!held.ok) return { ok: false, reason: held.reason };
        return {
          ok: false,
          reason: 'countersign_required',
          held: { enrollmentDigest: held.enrollmentDigest, expiresAt: held.expiresAt },
        };
      }
      if (
        !cs ||
        cs.confirmer.kind !== 'human' ||
        !cs.isAdmin ||
        cs.confirmer.id === input.member.id
      ) {
        return { ok: false, reason: 'countersign_required' };
      }
      // ADR 769: the countersign names the exact registration (its held-enrollment digest), so a
      // parked proof cannot enroll some other key for this member; and it must be a real
      // signature from a key that signs here, never an unenrolled admin's bearer pass.
      const check = await requireAuthority(db, {
        teamId: input.teamId,
        audience: input.audience,
        presenter: cs.confirmer,
        credential: 'human',
        act: 'device_key_admin',
        target: input.member.name,
        payload: {
          action: 'enroll',
          kind: 'passkey',
          member: input.member.name,
          key: heldEnrollmentDigest(heldFields),
        },
        proof: cs.proof,
        expectedOrigins: input.countersignExpectedOrigins ?? input.expectedOrigins,
        now,
      });
      if (!check.ok) return { ok: false, reason: check.reason };
      const signer = await countersignerKeyUsable(db, input.teamId, check, hosts);
      if (signer !== 'ok') return { ok: false, reason: signer };
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
    ...made,
    now,
  });
  await appendAudit(db, input.teamId, {
    actor: input.member.name,
    action: 'device_key.enrolled',
    target: input.member.name,
    result: 'allow',
    detail: { key_id: key.id, kind: 'passkey', via: recovery ? 'recovery' : 'ceremony' },
  });
  return { ok: true, key, via: recovery ? 'recovery' : 'ceremony' };
}

/**
 * ADR 769: this member's held enrollments still waiting for a vouch — the code unspent and
 * unexpired — newest first. The member's own read: a terminal that ran the ceremony in a browser
 * learns the digest here, to print the admin's approve line and the check code.
 */
export async function liveHeldEnrollments(
  db: Driver,
  teamId: string,
  memberId: string,
  now = Date.now(),
): Promise<{ enrollmentDigest: string; expiresAt: number }[]> {
  const rows = await db.all<{ digest: string; expires_at: number }>(
    `SELECT h.digest, c.expires_at
       FROM held_enrollments h
       JOIN enrollment_codes c ON c.team_id = h.team_id AND c.code_hash = h.code_hash
      WHERE h.team_id = ? AND h.member_id = ? AND c.used_at IS NULL AND c.expires_at >= ?
      ORDER BY h.created_at DESC`,
    [teamId, memberId, now],
  );
  return rows.map((r) => ({ enrollmentDigest: r.digest, expiresAt: Number(r.expires_at) }));
}

/**
 * ADR 769: a countersign or vouch counts only as a real signature (A2) by a key that is still
 * standing and, when the hub's hosts are known, signs where this hub serves. An admin with no
 * enrolled key passes `requireAuthority` as `bearer_unenrolled`: that is no countersign.
 */
async function countersignerKeyUsable(
  db: Driver,
  teamId: string,
  check: AuthorityCheck & { ok: true },
  hosts: readonly string[] | undefined,
): Promise<'ok' | 'countersigner_unenrolled' | 'countersigner_key_unusable'> {
  if (check.assurance !== 'A2') return 'countersigner_unenrolled';
  const key = await getDeviceKey(db, teamId, check.keyId);
  if (!key || key.revokedAt !== null) return 'countersigner_key_unusable';
  if (hosts !== undefined && !usableKeyStands([key], hosts)) return 'countersigner_key_unusable';
  return 'ok';
}

/**
 * ADR 769: an admin vouches for a member's held enrollment, and it is enrolled. One transaction;
 * every check runs inside it at commit time: the member still has no usable key, the code is
 * unspent and unexpired, the held record recomputes to the digest the admin signed, the admin is a
 * different human, admin now, signing with a standing key that signs here. Then the code is spent
 * and the key inserted together — a failed insert rolls the spend back, and a second vouch or a
 * replay finds the code spent.
 */
export async function vouchPasskeyGuarded(
  db: Driver,
  input: {
    teamId: string;
    audience: string;
    admin: { id: string; name: string; kind: string };
    /** The admin's capability resolved by the caller at this moment. */
    adminIsAdmin: boolean;
    memberName: string;
    enrollmentDigest: string;
    proof?: ApprovalProof | undefined;
    /** The hostnames of this hub's configured passkey origins. */
    hosts: readonly string[];
    expectedOrigins?: readonly string[] | undefined;
    now?: number;
  },
): Promise<EnrollKeyResult> {
  const now = input.now ?? Date.now();
  return db.tx(async (t) => {
    const member = await getMemberByName(t, input.teamId, input.memberName);
    if (!member || member.kind !== 'human' || member.left_at !== null)
      return { ok: false, reason: 'no_member' };
    if (input.admin.kind !== 'human' || !input.adminIsAdmin || input.admin.id === member.id)
      return { ok: false, reason: 'not_a_countersigner' };
    const held = await t.get<{
      code_hash: string;
      credential_id: string;
      public_key: string;
      origin: string | null;
      rp_id: string | null;
      digest: string;
      used_at: number | null;
      expires_at: number;
    }>(
      `SELECT h.code_hash, h.credential_id, h.public_key, h.origin, h.rp_id, h.digest,
              c.used_at, c.expires_at
         FROM held_enrollments h
         JOIN enrollment_codes c ON c.team_id = h.team_id AND c.code_hash = h.code_hash
        WHERE h.team_id = ? AND h.member_id = ? AND h.digest = ?`,
      [input.teamId, member.id, input.enrollmentDigest],
    );
    if (!held) return { ok: false, reason: 'no_held_enrollment' };
    if (held.used_at !== null) return { ok: false, reason: 'already_spent' };
    if (Number(held.expires_at) < now) return { ok: false, reason: 'expired' };
    const fields: HeldEnrollmentFields = {
      teamId: input.teamId,
      memberId: member.id,
      codeHash: held.code_hash,
      credentialId: held.credential_id,
      publicKey: held.public_key,
      origin: held.origin,
      rpId: held.rp_id,
    };
    if (heldEnrollmentDigest(fields) !== held.digest)
      return { ok: false, reason: 'held_record_altered' };
    if (usableKeyStands(await activeDeviceKeys(t, input.teamId, member.id), input.hosts))
      return { ok: false, reason: 'usable_key_stands' };
    const check = await requireAuthority(t, {
      teamId: input.teamId,
      audience: input.audience,
      presenter: input.admin,
      credential: 'human',
      act: 'device_key_admin',
      target: member.name,
      payload: { action: 'enroll', kind: 'passkey', member: member.name, key: held.digest },
      proof: input.proof,
      expectedOrigins: input.expectedOrigins,
      now,
    });
    if (!check.ok) return { ok: false, reason: check.reason };
    const signer = await countersignerKeyUsable(t, input.teamId, check, input.hosts);
    if (signer !== 'ok') return { ok: false, reason: signer };
    const spent = await t.run(
      `UPDATE enrollment_codes SET used_at = ?
        WHERE team_id = ? AND code_hash = ? AND member_id = ? AND used_at IS NULL AND expires_at >= ?`,
      [now, input.teamId, held.code_hash, member.id, now],
    );
    if (spent.changes === 0) return { ok: false, reason: 'already_spent' };
    const key = await enrollDeviceKey(t, {
      teamId: input.teamId,
      memberId: member.id,
      publicKey: held.public_key,
      kind: 'passkey',
      credentialId: held.credential_id,
      origin: held.origin,
      rpId: held.rp_id,
      now,
    });
    await appendAudit(t, input.teamId, {
      actor: member.name,
      action: 'device_key.enrolled',
      target: member.name,
      result: 'allow',
      detail: { key_id: key.id, kind: 'passkey', via: 'vouch', vouched_by: input.admin.name },
    });
    return { ok: true, key, via: 'vouch' };
  });
}
