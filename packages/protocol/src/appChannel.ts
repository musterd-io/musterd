import { z } from 'zod';

/**
 * The musterd app's channel (ADR 676): what the pairing QR carries and what the phone sends back,
 * sealed, to pair. Every key travels as raw bytes, base64url: Ed25519 is 32 bytes, a P-256 point
 * is the 65-byte uncompressed form. The daemon parses an opened pairing request through
 * {@link AppPairRequestSchema} before it reads a field (hard rule 4).
 */

export const APP_CHANNEL = 'app';
export const APP_QR_VERSION = 1;

const b64url = z.string().regex(/^[A-Za-z0-9_-]+$/);
const ed25519Raw = b64url.length(43);
const p256Raw = b64url.length(87);

/**
 * What the daemon's own page shows as a QR code (ADR 676 §5). `code` is the one-time pairing
 * nonce: it never reaches the relay in the clear, because the phone sends it back sealed.
 */
export const AppPairingQrSchema = z.object({
  v: z.literal(APP_QR_VERSION),
  /** The team's away-relay origin (`https:`), where the phone sends its sealed request. */
  relay: z.string().url().max(512),
  team: z.string().min(1).max(64),
  pairing: z.string().min(1).max(64),
  code: b64url.min(32).max(64),
  expires_at: z.number().int().nonnegative(),
  daemon_identity_public_key: ed25519Raw,
  daemon_receive_public_key: p256Raw,
});
export type AppPairingQr = z.infer<typeof AppPairingQrSchema>;

/**
 * The phone's pairing request, opened from a body sealed to the daemon's receive key with the
 * route `{team, binding: 'pairing', ref: <pairing id>, expires_at}` and purpose `pair`.
 * `attestation` is App Attest's CBOR attestation object over the challenge
 * sha256(code ‖ signing public key ‖ receive public key).
 */
export const AppPairRequestSchema = z.object({
  v: z.literal(1),
  code: b64url.min(32).max(64),
  signing_public_key: p256Raw,
  receive_public_key: p256Raw,
  attest_key_id: b64url.length(43),
  attestation: b64url.max(16_384),
  device_name: z.string().max(64).optional(),
});
export type AppPairRequest = z.infer<typeof AppPairRequestSchema>;

/** The relay route a pairing request is sealed under: the pairing, not yet a binding. */
export const APP_PAIRING_BINDING = 'pairing';
