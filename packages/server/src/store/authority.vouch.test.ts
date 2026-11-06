import { createHash, generateKeyPairSync, sign as cryptoSign, type KeyObject } from 'node:crypto';
import { descriptorSigningBytes } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  buildDescriptor,
  enrollDeviceKey,
  enrollPasskeyGuarded,
  issueEnrollmentChallenge,
  listDeviceKeys,
  revokeDeviceKey,
  vouchPasskeyGuarded,
} from './authority.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

/**
 * ADR 769: an admin vouches for a member's held passkey enrollment. These are the ADR's Eval
 * falsifiers (big-body's second security read): who is sent to the vouch, the held record bound
 * to the signed digest, the commit-time re-checks, replay, concurrency and rollback.
 */

let openStore: () => Promise<Driver>;

function head(major: number, len: number): Buffer {
  if (len < 24) return Buffer.from([(major << 5) | len]);
  if (len < 256) return Buffer.from([(major << 5) | 24, len]);
  return Buffer.from([(major << 5) | 25, len >> 8, len & 0xff]);
}
const encInt = (n: number) => (n >= 0 ? head(0, n) : head(1, -1 - n));
const encBytes = (b: Uint8Array) => Buffer.concat([head(2, b.length), Buffer.from(b)]);
const encText = (s: string) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([head(3, b.length), b]);
};
const encMap = (entries: [Uint8Array, Uint8Array][]) =>
  Buffer.concat([head(5, entries.length), ...entries.flatMap(([k, v]) => [k, v])]);

const ORIGIN = 'https://example.com';
const HOSTS = ['example.com'];

/** A self-made Ed25519 registration (fmt none, UP|UV|AT) for `challenge` on example.com. */
function registration(challenge: string, credName: string) {
  const { publicKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const cose = encMap([
    [encInt(1), encInt(1)],
    [encInt(3), encInt(-8)],
    [encInt(-1), encInt(6)],
    [encInt(-2), encBytes(Buffer.from(jwk.x, 'base64url'))],
  ]);
  const credId = Buffer.from(credName);
  const authData = Buffer.concat([
    createHash('sha256').update('example.com').digest(),
    Buffer.from([0x45]),
    Buffer.from([0, 0, 0, 0]),
    Buffer.alloc(16),
    Buffer.from([0, credId.length]),
    credId,
    cose,
  ]);
  return {
    attestationObject: encMap([
      [encText('fmt'), encText('none')],
      [encText('attStmt'), encMap([])],
      [encText('authData'), encBytes(authData)],
    ]),
    clientDataJson: JSON.stringify({
      type: 'webauthn.create',
      challenge,
      origin: ORIGIN,
      crossOrigin: false,
    }),
  };
}

const spkiOf = (k: KeyObject) => k.export({ format: 'der', type: 'spki' }).toString('base64url');

async function setup() {
  const db = await openStore();
  const team = await createTeam(db, { slug: 'revive' });
  const ada = (await addMember(db, team, { name: 'ada', kind: 'human' })).row;
  const root = (await addMember(db, team, { name: 'root', kind: 'human' })).row;
  const rootKp = generateKeyPairSync('ed25519');
  const rootKey = await enrollDeviceKey(db, {
    teamId: team.id,
    memberId: root.id,
    publicKey: spkiOf(rootKp.publicKey),
    kind: 'platform',
  });

  /** ada's ceremony with `hold`: returns the guarded result. */
  const hold = async (credName = 'ada-new', hosts: readonly string[] = HOSTS) => {
    const issued = await issueEnrollmentChallenge(db, {
      teamId: team.id,
      memberId: ada.id,
      actor: 'ada',
    });
    const reg = registration(issued.challenge, credName);
    const result = await enrollPasskeyGuarded(db, {
      teamId: team.id,
      audience: team.slug,
      member: ada,
      challenge: issued.challenge,
      expectedOrigins: [ORIGIN],
      recoveryHosts: hosts,
      hold: true,
      registration: reg,
    });
    return { result, challenge: issued.challenge, reg };
  };

  /** root signs `device_key_admin` over `payload` for ada with the platform key. */
  const rootProof = async (payload: unknown, kp = rootKp, keyId = rootKey.id) => {
    const d = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: root.id,
      actor: 'root',
      act: 'device_key_admin',
      target: 'ada',
      payload,
    });
    return {
      key_id: keyId,
      nonce: d.nonce,
      signature: cryptoSign(
        null,
        Buffer.from(descriptorSigningBytes(d), 'utf8'),
        kp.privateKey,
      ).toString('base64url'),
    };
  };

  const vouchPayload = (digest: string) => ({
    action: 'enroll',
    kind: 'passkey',
    member: 'ada',
    key: digest,
  });

  const vouch = async (
    digest: string,
    proof: Awaited<ReturnType<typeof rootProof>> | undefined,
    over: Partial<Parameters<typeof vouchPasskeyGuarded>[1]> = {},
  ) =>
    vouchPasskeyGuarded(db, {
      teamId: team.id,
      audience: team.slug,
      admin: root,
      adminIsAdmin: true,
      memberName: 'ada',
      enrollmentDigest: digest,
      proof,
      hosts: HOSTS,
      expectedOrigins: [ORIGIN],
      ...over,
    });

  return { db, team, ada, root, rootKp, rootKey, hold, rootProof, vouchPayload, vouch };
}

const digestOf = (r: Awaited<ReturnType<typeof enrollPasskeyGuarded>>): string => {
  if (r.ok || !r.held) throw new Error(`expected a held enrollment, got ${JSON.stringify(r)}`);
  return r.held.enrollmentDigest;
};

withDrivers('passkey vouch (ADR 769)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('holds a verified registration, enrolls nothing, and holds it only once', async () => {
    const s = await setup();
    const { result, challenge, reg } = await s.hold();
    const digest = digestOf(result);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(await listDeviceKeys(s.db, s.team.id, s.ada.id)).toEqual([]);

    // The same registration again: same digest. Another registration on that code: refused.
    const again = await enrollPasskeyGuarded(s.db, {
      teamId: s.team.id,
      audience: s.team.slug,
      member: s.ada,
      challenge,
      expectedOrigins: [ORIGIN],
      recoveryHosts: HOSTS,
      hold: true,
      registration: reg,
    });
    expect(digestOf(again)).toBe(digest);
    const other = await enrollPasskeyGuarded(s.db, {
      teamId: s.team.id,
      audience: s.team.slug,
      member: s.ada,
      challenge,
      expectedOrigins: [ORIGIN],
      recoveryHosts: HOSTS,
      hold: true,
      registration: registration(challenge, 'ada-swapped'),
    });
    expect(other).toEqual({ ok: false, reason: 'already_held' });
  });

  it('enrolls the held key on a vouch signed over its digest, once', async () => {
    const s = await setup();
    const digest = digestOf((await s.hold()).result);
    const enrolled = await s.vouch(digest, await s.rootProof(s.vouchPayload(digest)));
    expect(enrolled.ok && enrolled.via).toBe('vouch');
    const keys = await listDeviceKeys(s.db, s.team.id, s.ada.id);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatchObject({ kind: 'passkey', origin: ORIGIN, rpId: 'example.com' });

    const audit = await s.db.all<{ detail: string }>(
      `SELECT detail FROM audit WHERE team_id = ? AND action = 'device_key.enrolled'`,
      [s.team.id],
    );
    expect(JSON.parse(audit.at(-1)!.detail)).toMatchObject({ via: 'vouch', vouched_by: 'root' });

    // A second vouch (or a replay of the same proof) finds the code spent.
    await expect(s.vouch(digest, await s.rootProof(s.vouchPayload(digest)))).resolves.toEqual({
      ok: false,
      reason: 'already_spent',
    });
  });

  it('refuses a digest with no held enrollment, an altered record, and an expired code', async () => {
    const s = await setup();
    const digest = digestOf((await s.hold()).result);
    const wrong = 'f'.repeat(64);
    await expect(s.vouch(wrong, await s.rootProof(s.vouchPayload(wrong)))).resolves.toEqual({
      ok: false,
      reason: 'no_held_enrollment',
    });

    // Someone with the store swaps the held public key: the record no longer hashes to the digest.
    await s.db.run(`UPDATE held_enrollments SET public_key = ? WHERE digest = ?`, [
      spkiOf(generateKeyPairSync('ed25519').publicKey),
      digest,
    ]);
    await expect(s.vouch(digest, await s.rootProof(s.vouchPayload(digest)))).resolves.toEqual({
      ok: false,
      reason: 'held_record_altered',
    });

    const fresh = digestOf((await s.hold('ada-second')).result);
    await expect(
      s.vouch(fresh, await s.rootProof(s.vouchPayload(fresh)), { now: Date.now() + 11 * 60_000 }),
    ).resolves.toEqual({ ok: false, reason: 'expired' });
  });

  it('a generic device_key_admin proof cannot stand in for the key-bound one', async () => {
    const s = await setup();
    const digest = digestOf((await s.hold()).result);
    const generic = await s.rootProof({ action: 'enroll', kind: 'passkey', member: 'ada' });
    const refused = await s.vouch(digest, generic);
    expect(refused.ok).toBe(false);
    expect(await listDeviceKeys(s.db, s.team.id, s.ada.id)).toEqual([]);
  });

  it('only a different human admin, admin now, with a standing key, can vouch', async () => {
    const s = await setup();
    const digest = digestOf((await s.hold()).result);
    const proof = await s.rootProof(s.vouchPayload(digest));
    await expect(s.vouch(digest, proof, { adminIsAdmin: false })).resolves.toEqual({
      ok: false,
      reason: 'not_a_countersigner',
    });
    await expect(s.vouch(digest, proof, { admin: s.ada })).resolves.toEqual({
      ok: false,
      reason: 'not_a_countersigner',
    });

    // An admin with no enrolled key passes the gate as bearer_unenrolled: that is no vouch.
    const bob = (await addMember(s.db, s.team, { name: 'bob', kind: 'human' })).row;
    await expect(s.vouch(digest, undefined, { admin: bob })).resolves.toEqual({
      ok: false,
      reason: 'countersigner_unenrolled',
    });

    // root's key revoked mid-request: refused.
    await revokeDeviceKey(s.db, s.team.id, s.rootKey.id);
    const afterRevoke = await s.vouch(digest, await s.rootProof(s.vouchPayload(digest)));
    expect(afterRevoke.ok).toBe(false);
    expect(await listDeviceKeys(s.db, s.team.id, s.ada.id)).toEqual([]);
  });

  it('who is sent here: a usable key on any configured host keeps the standing-key approval', async () => {
    const s = await setup();
    const hosts = ['example.com', 'other.example'];
    await enrollDeviceKey(s.db, {
      teamId: s.team.id,
      memberId: s.ada.id,
      publicKey: spkiOf(generateKeyPairSync('ed25519').publicKey),
      kind: 'passkey',
      origin: 'https://other.example',
      rpId: 'other.example',
    });
    const { result } = await s.hold('ada-new', hosts);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.held).toBeUndefined();
  });

  it('who is sent here: dead-origin and unrecorded passkeys count as unusable (stated trade)', async () => {
    const s = await setup();
    for (const rpId of ['localhost', null]) {
      await enrollDeviceKey(s.db, {
        teamId: s.team.id,
        memberId: s.ada.id,
        publicKey: spkiOf(generateKeyPairSync('ed25519').publicKey),
        kind: 'passkey',
        origin: rpId ? `http://${rpId}:4849` : null,
        rpId,
      });
    }
    const digest = digestOf((await s.hold()).result);
    const enrolled = await s.vouch(digest, await s.rootProof(s.vouchPayload(digest)));
    expect(enrolled.ok).toBe(true);
  });

  it('re-checks at commit: a usable key that appeared since the hold refuses the vouch', async () => {
    const s = await setup();
    const digest = digestOf((await s.hold()).result);
    await enrollDeviceKey(s.db, {
      teamId: s.team.id,
      memberId: s.ada.id,
      publicKey: spkiOf(generateKeyPairSync('ed25519').publicKey),
      kind: 'platform',
    });
    await expect(s.vouch(digest, await s.rootProof(s.vouchPayload(digest)))).resolves.toEqual({
      ok: false,
      reason: 'usable_key_stands',
    });
  });

  it('two simultaneous vouches enroll one key', async () => {
    const s = await setup();
    const digest = digestOf((await s.hold()).result);
    const [p1, p2] = [
      await s.rootProof(s.vouchPayload(digest)),
      await s.rootProof(s.vouchPayload(digest)),
    ];
    const results = await Promise.all([s.vouch(digest, p1), s.vouch(digest, p2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await listDeviceKeys(s.db, s.team.id, s.ada.id)).toHaveLength(1);
  });

  it('a failed insert rolls the spend back: the code stays usable', async () => {
    const s = await setup();
    const digest = digestOf((await s.hold()).result);
    if (s.db.dialect === 'sqlite') {
      await s.db.exec(
        `CREATE TRIGGER vouch_boom BEFORE INSERT ON device_keys BEGIN SELECT RAISE(ABORT, 'boom'); END`,
      );
    } else {
      await s.db.exec(
        `CREATE FUNCTION vouch_boom() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'boom'; END $$ LANGUAGE plpgsql;
         CREATE TRIGGER vouch_boom BEFORE INSERT ON device_keys FOR EACH ROW EXECUTE FUNCTION vouch_boom()`,
      );
    }
    await expect(s.vouch(digest, await s.rootProof(s.vouchPayload(digest)))).rejects.toThrow();
    await s.db.exec(
      s.db.dialect === 'sqlite'
        ? `DROP TRIGGER vouch_boom`
        : `DROP TRIGGER vouch_boom ON device_keys; DROP FUNCTION vouch_boom()`,
    );
    const retried = await s.vouch(digest, await s.rootProof(s.vouchPayload(digest)));
    expect(retried.ok).toBe(true);
  });

  it('the one-shot countersign must name the registration too (key = held digest)', async () => {
    const s = await setup();
    const { result, challenge, reg } = await s.hold();
    const digest = digestOf(result);
    const submit = (proof: Awaited<ReturnType<typeof s.rootProof>>) =>
      enrollPasskeyGuarded(s.db, {
        teamId: s.team.id,
        audience: s.team.slug,
        member: s.ada,
        challenge,
        expectedOrigins: [ORIGIN],
        recoveryHosts: HOSTS,
        countersign: { confirmer: s.root, isAdmin: true, proof },
        registration: reg,
      });
    const generic = await submit(
      await s.rootProof({ action: 'enroll', kind: 'passkey', member: 'ada' }),
    );
    expect(generic.ok).toBe(false);
    const named = await submit(await s.rootProof(s.vouchPayload(digest)));
    expect(named.ok).toBe(true);
  });
});
