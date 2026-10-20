import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { expect, it } from 'vitest';
import { verifyAssertion, verifyRegistration } from './webauthn.js';

// Minimal CBOR encoder for fixtures (the decoder under test reads what a browser sends).
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

function fixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string };
  const rawX = Buffer.from(jwk.x, 'base64url');
  const cose = encMap([
    [encInt(1), encInt(1)],
    [encInt(3), encInt(-8)],
    [encInt(-1), encInt(6)],
    [encInt(-2), encBytes(rawX)],
  ]);
  const credId = Buffer.from('credential-1');
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
  return { publicKey, privateKey, credId, rpHash, regAuthData, attestationObject };
}

const clientData = (type: string, challenge: string) =>
  JSON.stringify({ type, challenge, origin: 'https://example.com', crossOrigin: false });

it('registration extracts the credential and assertion verifies against it', async () => {
  const { extractAuthData } = await import('./webauthn.js');
  const f = fixture();
  const code = 'code-123';
  const verified = verifyRegistration({
    authenticatorData: extractAuthData(f.attestationObject),
    clientDataJson: clientData('webauthn.create', Buffer.from(code, 'utf8').toString('base64url')),
    expectedChallenge: Buffer.from(code, 'utf8').toString('base64url'),
  });
  expect(verified.credentialId).toBe(f.credId.toString('base64url'));
  expect(verified.publicKeySpki).toBe(
    f.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'),
  );

  // Assertion: flags UP only, challenge is the approval nonce.
  const nonce = 'nonce-at-least-16-chars';
  const getAuthData = Buffer.concat([f.rpHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 9])]);
  const cdj = clientData('webauthn.get', nonce);
  const signed = Buffer.concat([getAuthData, createHash('sha256').update(cdj).digest()]);
  const signature = cryptoSign(null, signed, f.privateKey);
  expect(
    verifyAssertion({
      authenticatorData: getAuthData,
      clientDataJson: cdj,
      signature,
      publicKeySpki: verified.publicKeySpki,
      expectedChallenge: nonce,
    }),
  ).toBe(true);
  // A different challenge, and a tampered signature, both fail.
  expect(
    verifyAssertion({
      authenticatorData: getAuthData,
      clientDataJson: clientData('webauthn.get', 'another-nonce-16ch'),
      signature,
      publicKeySpki: verified.publicKeySpki,
      expectedChallenge: nonce,
    }),
  ).toBe(false);
  const bad = Buffer.from(signature);
  bad[0] ^= 0xff;
  expect(
    verifyAssertion({
      authenticatorData: getAuthData,
      clientDataJson: cdj,
      signature: bad,
      publicKeySpki: verified.publicKeySpki,
      expectedChallenge: nonce,
    }),
  ).toBe(false);
});

it('an origin the daemon is not configured for never verifies, however consistent', async () => {
  const { extractAuthData } = await import('./webauthn.js');
  const f = fixture();
  const nonce = 'nonce-at-least-16-chars';
  const getAuthData = Buffer.concat([f.rpHash, Buffer.from([0x01]), Buffer.from([0, 0, 0, 9])]);
  const cdj = clientData('webauthn.get', nonce);
  const signature = cryptoSign(
    null,
    Buffer.concat([getAuthData, createHash('sha256').update(cdj).digest()]),
    f.privateKey,
  );
  const spki = f.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url');
  // The daemon's own configured origin: verifies.
  expect(
    verifyAssertion({
      authenticatorData: getAuthData,
      clientDataJson: cdj,
      signature,
      publicKeySpki: spki,
      expectedChallenge: nonce,
      expectedOrigins: ['https://example.com'],
    }),
  ).toBe(true);
  // A relay-hosted ceremony's origin (ADR 618 §2): refused at assertion and registration.
  expect(
    verifyAssertion({
      authenticatorData: getAuthData,
      clientDataJson: cdj,
      signature,
      publicKeySpki: spki,
      expectedChallenge: nonce,
      expectedOrigins: ['https://relay.example.net'],
    }),
  ).toBe(false);
  expect(() =>
    verifyRegistration({
      authenticatorData: extractAuthData(f.attestationObject),
      clientDataJson: clientData('webauthn.create', 'challenge-0123456789'),
      expectedChallenge: 'challenge-0123456789',
      expectedOrigins: ['https://relay.example.net'],
    }),
  ).toThrow(/origin/);
});
