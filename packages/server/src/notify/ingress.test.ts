import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { expect, it } from 'vitest';
import { ingressPublicKeyFrom, ingressSignedPayload, verifyIngressAttestation } from './ingress.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const pem = publicKey.export({ format: 'pem', type: 'spki' }) as string;
const derB64 = (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');

function signed(body: string, ts = Date.now()) {
  return {
    timestamp: String(ts),
    signature: cryptoSign(null, ingressSignedPayload(String(ts), body), privateKey).toString(
      'base64url',
    ),
  };
}

it('verifies a fresh attestation (PEM or DER key) and refuses forgery, tampering, staleness', () => {
  const body = 'payload=%7B%22a%22%3A1%7D';
  const { timestamp, signature } = signed(body);
  expect(verifyIngressAttestation({ publicKey: pem, timestamp, signature, rawBody: body })).toBe(
    true,
  );
  expect(verifyIngressAttestation({ publicKey: derB64, timestamp, signature, rawBody: body })).toBe(
    true,
  );
  // Tampered body.
  expect(
    verifyIngressAttestation({ publicKey: pem, timestamp, signature, rawBody: body + 'x' }),
  ).toBe(false);
  // Stale timestamp, even with a valid signature over it.
  const old = signed(body, Date.now() - 6 * 60_000);
  expect(
    verifyIngressAttestation({
      publicKey: pem,
      timestamp: old.timestamp,
      signature: old.signature,
      rawBody: body,
    }),
  ).toBe(false);
  // Garbage inputs refuse, never throw.
  expect(verifyIngressAttestation({ publicKey: 'nope', timestamp, signature, rawBody: body })).toBe(
    false,
  );
  expect(
    verifyIngressAttestation({ publicKey: pem, timestamp: 'x', signature, rawBody: body }),
  ).toBe(false);
  expect(ingressPublicKeyFrom('nope')).toBeNull();
});
