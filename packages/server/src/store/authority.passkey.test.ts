import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { beforeEach, expect, it } from 'vitest';
import type { Driver } from '../db/driver.js';
import { withDrivers } from '../db/testing.js';
import {
  buildDescriptor,
  enrollPasskeyGuarded,
  getParkedProof,
  issueEnrollmentCode,
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

  it('enroll by code, park a proof from the page, and the act verifies it', async () => {
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
      Buffer.from([0x41]),
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

    const issued = await issueEnrollmentCode(db, {
      teamId: team.id,
      memberId: nick.id,
      actor: 'nick',
    });
    const enrolled = await enrollPasskeyGuarded(db, {
      teamId: team.id,
      member: nick,
      code: issued.code,
      registration: {
        attestationObject,
        clientDataJson: clientData(
          'webauthn.create',
          Buffer.from(issued.code, 'utf8').toString('base64url'),
        ),
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
      storePasskeyProof(db, { teamId: team.id, audience: team.slug, proof }),
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
      }),
    ).resolves.toEqual({ ok: true, assurance: 'A2', keyId, kind: 'passkey' });
  });
});
