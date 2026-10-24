import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes } from '@musterd/protocol';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  buildDescriptor,
  consumeEnrollmentChallenge,
  enrollDeviceKey,
  enrollPasskeyGuarded,
  getParkedProof,
  issueEnrollmentChallenge,
  requireAuthority,
  storePasskeyProof,
} from './authority.js';
import { addMember } from './members.js';
import { createTeam } from './teams.js';

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

withDrivers('passkey authenticator (ADR 662 decision 5)', (o) => {
  beforeEach(() => {
    openStore = o;
  });

  it('enroll by ceremony, park a proof from the page, and the act verifies it', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;

    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    const cose = encMap([
      [encInt(1), encInt(1)],
      [encInt(3), encInt(-8)],
      [encInt(-1), encInt(6)],
      [encInt(-2), encBytes(Buffer.from(jwk.x, 'base64url'))],
    ]);
    const credId = Buffer.from('phone-credential');
    const rpHash = createHash('sha256').update('example.com').digest();
    const regAuthData = Buffer.concat([
      rpHash,
      Buffer.from([0x45]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.alloc(16),
      Buffer.from([0, credId.length]),
      credId,
      cose,
    ]);
    const attestationObject = encMap([
      [encText('fmt'), encText('none')],
      [encText('attStmt'), encMap([])],
      [encText('authData'), encBytes(regAuthData)],
    ]);
    const clientData = (type: string, challenge: string) =>
      JSON.stringify({ type, challenge, origin: 'https://example.com', crossOrigin: false });

    const issued = await issueEnrollmentChallenge(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
    });
    // A ceremony on an origin this daemon is not configured for enrolls nothing.
    const refused = await enrollPasskeyGuarded(db, {
      teamId: team.id,
      audience: team.slug,
      member: nick,
      challenge: issued.challenge,
      expectedOrigins: ['https://relay.example.net'],
      registration: {
        attestationObject,
        clientDataJson: clientData('webauthn.create', issued.challenge),
      },
    });
    expect(refused).toEqual({ ok: false, reason: 'bad_registration' });
    const enrolled = await enrollPasskeyGuarded(db, {
      teamId: team.id,
      audience: team.slug,
      member: nick,
      challenge: issued.challenge,
      expectedOrigins: ['https://example.com'],
      registration: {
        attestationObject,
        clientDataJson: clientData('webauthn.create', issued.challenge),
      },
    });
    expect(enrolled.ok).toBe(true);
    const keyId = enrolled.ok ? enrolled.key.id : '';

    // The gate now demands an assertion: the Bearer alone is refused.
    const act = { act: 'human_accept' as const, target: '01LANE', payload: { state: 'done' } };
    await expect(
      requireAuthority(db, {
        teamId: team.id,
        audience: team.slug,
        presenter: nick,
        credential: 'human',
        ...act,
      }),
    ).resolves.toEqual({ ok: false, reason: 'no_signature' });

    const descriptor = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      ...act,
    });
    const getAuthData = Buffer.concat([rpHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 3])]);
    const cdj = clientData('webauthn.get', descriptor.nonce);
    const signature = cryptoSign(
      null,
      Buffer.concat([getAuthData, createHash('sha256').update(cdj).digest()]),
      privateKey,
    );
    const proof = {
      key_id: keyId,
      nonce: descriptor.nonce,
      signature: signature.toString('base64url'),
      authenticator_data: getAuthData.toString('base64url'),
      client_data_json: cdj,
    };
    // The page parks the verified proof; the waiting surface collects and presents it.
    await expect(
      storePasskeyProof(db, {
        teamId: team.id,
        audience: team.slug,
        proof,
        expectedOrigins: ['https://example.com'],
      }),
    ).resolves.toBe(true);
    const parked = await getParkedProof(db, team.id, descriptor.nonce);
    expect(parked).toEqual(proof);
    await expect(
      requireAuthority(db, {
        teamId: team.id,
        audience: team.slug,
        presenter: nick,
        credential: 'human',
        ...act,
        proof: parked!,
        expectedOrigins: ['https://example.com'],
      }),
    ).resolves.toEqual({ ok: true, assurance: 'A2', keyId, kind: 'passkey' });

    // The act path (route.ts passes the daemon's configured origins): a
    // relay-origin assertion refuses even with a valid signature (HA3 re-review).
    const d2 = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: nick.id,
      actor: 'nick',
      ...act,
    });
    const relayAuthData = Buffer.concat([rpHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 4])]);
    const relayCdj = JSON.stringify({
      type: 'webauthn.get',
      challenge: d2.nonce,
      origin: 'https://relay.example.net',
      crossOrigin: false,
    });
    const relaySig = cryptoSign(
      null,
      Buffer.concat([relayAuthData, createHash('sha256').update(relayCdj).digest()]),
      privateKey,
    );
    await expect(
      requireAuthority(db, {
        teamId: team.id,
        audience: team.slug,
        presenter: nick,
        credential: 'human',
        ...act,
        proof: {
          key_id: keyId,
          nonce: d2.nonce,
          signature: relaySig.toString('base64url'),
          authenticator_data: relayAuthData.toString('base64url'),
          client_data_json: relayCdj,
        },
        expectedOrigins: ['https://example.com'],
      }),
    ).resolves.toEqual({ ok: false, reason: 'descriptor_mismatch' });
  });

  it('spends an enrollment challenge only for its bound node and WebAuthn origin', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const swetha = (await addMember(db, team, { name: 'swetha', kind: 'human' })).row;
    const issued = await issueEnrollmentChallenge(db, {
      teamId: team.id,
      memberId: swetha.id,
      actor: swetha.name,
      nodeId: 'node-air2',
      ceremonyOrigin: 'https://air2.example',
      ceremonyRpId: 'air2.example',
    });
    await expect(
      consumeEnrollmentChallenge(db, {
        teamId: team.id,
        memberId: swetha.id,
        challenge: issued.challenge,
        nodeId: 'node-hub',
        ceremonyOrigin: 'https://air2.example',
        ceremonyRpId: 'air2.example',
      }),
    ).resolves.toBe(false);
    await expect(
      consumeEnrollmentChallenge(db, {
        teamId: team.id,
        memberId: swetha.id,
        challenge: issued.challenge,
        nodeId: 'node-air2',
        ceremonyOrigin: 'https://wrong.example',
        ceremonyRpId: 'wrong.example',
      }),
    ).resolves.toBe(false);
    await expect(
      consumeEnrollmentChallenge(db, {
        teamId: team.id,
        memberId: swetha.id,
        challenge: issued.challenge,
        nodeId: 'node-air2',
        ceremonyOrigin: 'https://air2.example',
        ceremonyRpId: 'air2.example',
      }),
    ).resolves.toBe(true);
  });

  it('past genesis, a fabricated registration enrolls nothing without an admin countersign', async () => {
    const db = await openStore();
    const team = await createTeam(db, { slug: 'revive' });
    const nick = (await addMember(db, team, { name: 'nick', kind: 'human' })).row;
    const root = (await addMember(db, team, { name: 'root', kind: 'human' })).row;

    // Root already has a standing key: genesis is over for this team.
    const rootKp = generateKeyPairSync('ed25519');
    const rootKey = await enrollDeviceKey(db, {
      teamId: team.id,
      memberId: root.id,
      publicKey: rootKp.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
      kind: 'platform',
    });

    // Lazara's fabricated registration: a self-generated Ed25519 COSE key, flags
    // UP|UV|AT, fmt none — no authenticator anywhere. It verifies as a ceremony…
    const { publicKey } = generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
    const cose = encMap([
      [encInt(1), encInt(1)],
      [encInt(3), encInt(-8)],
      [encInt(-1), encInt(6)],
      [encInt(-2), encBytes(Buffer.from(jwk.x, 'base64url'))],
    ]);
    const credId = Buffer.from('fabricated-credential');
    const rpHash = createHash('sha256').update('example.com').digest();
    const regAuthData = Buffer.concat([
      rpHash,
      Buffer.from([0x45]),
      Buffer.from([0, 0, 0, 0]),
      Buffer.alloc(16),
      Buffer.from([0, credId.length]),
      credId,
      cose,
    ]);
    const attestationObject = encMap([
      [encText('fmt'), encText('none')],
      [encText('attStmt'), encMap([])],
      [encText('authData'), encBytes(regAuthData)],
    ]);
    const clientData = (type: string, challenge: string) =>
      JSON.stringify({ type, challenge, origin: 'https://example.com', crossOrigin: false });
    const issued = await issueEnrollmentChallenge(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
    });
    const attempt = (countersign?: {
      confirmer: { id: string; name: string; kind: string };
      isAdmin: boolean;
      proof?: { key_id: string; nonce: string; signature: string };
    }) =>
      enrollPasskeyGuarded(db, {
        teamId: team.id,
        audience: team.slug,
        member: nick,
        challenge: issued.challenge,
        expectedOrigins: ['https://example.com'],
        countersign,
        registration: {
          attestationObject,
          clientDataJson: clientData('webauthn.create', issued.challenge),
        },
      });

    // …but enrolls nothing: no countersign, and none from a non-admin, both refuse.
    await expect(attempt()).resolves.toEqual({ ok: false, reason: 'countersign_required' });
    await expect(attempt({ confirmer: nick, isAdmin: false })).resolves.toEqual({
      ok: false,
      reason: 'countersign_required',
    });

    // Root, a human admin with a standing key, countersigns — now it enrolls.
    const d = await buildDescriptor(db, {
      teamId: team.id,
      audience: team.slug,
      memberId: root.id,
      actor: 'root',
      act: 'device_key_admin',
      target: 'nick',
      payload: { action: 'enroll', kind: 'passkey', member: 'nick' },
    });
    const proof = {
      key_id: rootKey.id,
      nonce: d.nonce,
      signature: cryptoSign(
        null,
        Buffer.from(descriptorSigningBytes(d), 'utf8'),
        rootKp.privateKey,
      ).toString('base64url'),
    };
    const enrolled = await attempt({ confirmer: root, isAdmin: true, proof });
    expect(enrolled.ok).toBe(true);
  });
});
