import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { descriptorSigningBytes, type ApprovalDescriptor } from '@musterd/protocol';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { openTestDriver, withDrivers } from '../db/testing.js';
import { createServer, type RunningServer } from '../index.js';
import { enrollDeviceKey } from '../store/authority.js';
import { getMemberByName } from '../store/members.js';
import { getTeamBySlug } from '../store/teams.js';

/**
 * ADR 769 at the transport edge: a member's registration is held (202 + digest) only when the
 * client asks, an admin's vouch over that digest enrolls it once, and nobody vouches for
 * themself. The store-level falsifiers live in `store/authority.vouch.test.ts`.
 */

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

function registration(challenge: string) {
  const jwk = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }) as { x: string };
  const cose = encMap([
    [encInt(1), encInt(1)],
    [encInt(3), encInt(-8)],
    [encInt(-1), encInt(6)],
    [encInt(-2), encBytes(Buffer.from(jwk.x, 'base64url'))],
  ]);
  const credId = Buffer.from('ada-laptop');
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
    attestation_object: encMap([
      [encText('fmt'), encText('none')],
      [encText('attStmt'), encMap([])],
      [encText('authData'), encBytes(authData)],
    ]).toString('base64url'),
    client_data_json: JSON.stringify({
      type: 'webauthn.create',
      challenge,
      origin: ORIGIN,
      crossOrigin: false,
    }),
  };
}

withDrivers('passkey vouch over http (ADR 769)', (_o, kind) => {
  let server: RunningServer;
  let base: string;
  let nick: string;
  let ada: string;
  let nickKeyId: string;
  let signAsNick: (d: ApprovalDescriptor) => string;

  async function call(method: string, path: string, token: string, body?: unknown) {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as any) : null };
  }

  beforeEach(async () => {
    server = createServer({ db: await openTestDriver(kind), port: 0, webauthnOrigins: [ORIGIN] });
    base = `http://127.0.0.1:${(await server.listen()).port}`;
    const team = await call('POST', '/teams', '', {
      slug: 'dawn',
      creator: { name: 'nick', kind: 'human' },
    });
    nick = team.json.human_credential;
    ada = (await call('POST', '/teams/dawn/members', nick, { name: 'ada', kind: 'human' })).json
      .human_credential;
    const teamRow = (await getTeamBySlug(server.store, 'dawn'))!;
    const nickRow = (await getMemberByName(server.store, teamRow.id, 'nick'))!;
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    signAsNick = (d) =>
      cryptoSign(null, Buffer.from(descriptorSigningBytes(d), 'utf8'), privateKey).toString(
        'base64url',
      );
    nickKeyId = (
      await enrollDeviceKey(server.store, {
        teamId: teamRow.id,
        memberId: nickRow.id,
        publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
        kind: 'platform',
      })
    ).id;
  });

  afterEach(async () => {
    await server.close();
  });

  async function nickProof(payload: unknown) {
    const d = await call('POST', '/teams/dawn/authority/descriptors', nick, {
      act: 'device_key_admin',
      target: 'ada',
      payload,
    });
    expect(d.status).toBe(201);
    const descriptor = d.json.descriptor as ApprovalDescriptor;
    return { key_id: nickKeyId, nonce: descriptor.nonce, signature: signAsNick(descriptor) };
  }

  it('holds on request, enrolls on a vouch over the digest, and only once', async () => {
    const issued = await call('POST', '/teams/dawn/authority/enrollment-challenges', ada);
    expect(issued.status).toBe(201);
    const reg = registration(issued.json.challenge);
    const enroll = (extra: Record<string, unknown>) =>
      call('POST', '/teams/dawn/authority/passkeys', ada, {
        actor: 'ada',
        challenge: issued.json.challenge,
        registration: reg,
        ...extra,
      });

    // An older client (no `hold`) sees exactly today's refusal.
    const old = await enroll({});
    expect(old.status).toBe(422);
    expect(JSON.stringify(old.json)).toContain('countersign_required');

    const held = await enroll({ hold: true });
    expect(held.status).toBe(202);
    const digest = held.json.held.enrollment_digest as string;
    expect(digest).toMatch(/^[0-9a-f]{64}$/);

    const payload = { action: 'enroll', kind: 'passkey', member: 'ada', key: digest };
    // ada cannot vouch for herself, even with nick's proof in hand.
    const self = await call('POST', '/teams/dawn/authority/passkeys/vouch', ada, {
      member: 'ada',
      enrollment_digest: digest,
      approval: await nickProof(payload),
    });
    expect(self.status).toBe(422);
    expect(JSON.stringify(self.json)).toContain('not_a_countersigner');

    const vouched = await call('POST', '/teams/dawn/authority/passkeys/vouch', nick, {
      member: 'ada',
      enrollment_digest: digest,
      approval: await nickProof(payload),
    });
    expect(vouched.status).toBe(201);
    expect(vouched.json.key.kind).toBe('passkey');
    const keys = await call('GET', '/teams/dawn/authority/keys', ada);
    expect(keys.json.keys.filter((k: { kind: string }) => k.kind === 'passkey')).toHaveLength(1);

    const replay = await call('POST', '/teams/dawn/authority/passkeys/vouch', nick, {
      member: 'ada',
      enrollment_digest: digest,
      approval: await nickProof(payload),
    });
    expect(replay.status).toBe(422);
    expect(JSON.stringify(replay.json)).toContain('already_spent');
  });

  it('a digest with no held enrollment is not found; a malformed one is a bad request', async () => {
    const wrong = 'a'.repeat(64);
    const none = await call('POST', '/teams/dawn/authority/passkeys/vouch', nick, {
      member: 'ada',
      enrollment_digest: wrong,
      approval: await nickProof({ action: 'enroll', kind: 'passkey', member: 'ada', key: wrong }),
    });
    expect(none.status).toBe(404);
    const malformed = await call('POST', '/teams/dawn/authority/passkeys/vouch', nick, {
      member: 'ada',
      enrollment_digest: 'not-hex',
      approval: { key_id: nickKeyId, nonce: 'x'.repeat(16), signature: 'x' },
    });
    expect(malformed.status).toBe(400);
  });
});
