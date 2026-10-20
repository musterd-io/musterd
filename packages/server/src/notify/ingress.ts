import { createPublicKey, verify as cryptoVerify, type KeyObject } from 'node:crypto';

/**
 * The Slack ingress attestation (spec: Slack ingress §3; away channels 10, lane
 * 01M50ZQQW95YDYVWE2BTCMKKH7). The shared ingress Worker signs every dispatch to a
 * Cloud server — the raw Slack body, unmodified — with its Ed25519 key; the receiving
 * server holds only the public key and verifies before it re-parses or redeems anything.
 * The Slack signing secret is never copied here: this key attests "the ingress verified
 * Slack and chose this destination", and the server then re-checks team, binding and ask
 * token against its own state, exactly as it does for a relay-forwarded callback.
 *
 * The signed payload is `<timestamp>.<raw body>`; the timestamp tolerance matches
 * Slack's own five minutes. A bad key, a stale timestamp, or a tampered body all refuse.
 */

export const INGRESS_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export function ingressSignedPayload(timestamp: string, rawBody: string): Buffer {
  return Buffer.from(`${timestamp}.${rawBody}`, 'utf8');
}

/** The operator's key material: a PEM string, or base64url DER (SPKI) for env vars. */
export function ingressPublicKeyFrom(material: string): KeyObject | null {
  try {
    if (material.includes('BEGIN')) return createPublicKey(material);
    return createPublicKey({
      key: Buffer.from(material, 'base64url'),
      format: 'der',
      type: 'spki',
    });
  } catch {
    return null;
  }
}

export function verifyIngressAttestation(input: {
  publicKey: string;
  timestamp: string;
  signature: string;
  rawBody: string;
  now?: number;
}): boolean {
  const now = input.now ?? Date.now();
  const ts = Number(input.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now - ts) > INGRESS_TIMESTAMP_TOLERANCE_MS) return false;
  const key = ingressPublicKeyFrom(input.publicKey);
  if (!key) return false;
  try {
    return cryptoVerify(
      null,
      ingressSignedPayload(input.timestamp, input.rawBody),
      key,
      Buffer.from(input.signature, 'base64url'),
    );
  } catch {
    return false;
  }
}
