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

/** A sealed body on the wire (`notify/appSeal.ts`): HPKE encapsulated key and ciphertext, base64url. */
export const SealedBodySchema = z.object({
  v: z.literal(1),
  enc: b64url.max(256),
  ct: b64url.max(65_536),
});
export type SealedBodyWire = z.infer<typeof SealedBodySchema>;

/**
 * At or under this many bytes of sealed body the relay puts it in the push; over it the push carries
 * only the ask ref and the phone fetches the body through the relay (ADR 676 §2).
 */
export const APP_PUSH_INLINE_MAX_BYTES = 3_072;

/**
 * What the phone sends through the relay (ADR 676 §6, §8): the relay forwards it as a callback body.
 * The route fields are what the seal was made under; the daemon opens with them and nothing else.
 * - `pair`: the pairing request, `binding: 'pairing'`, `ref` = the pairing id.
 * - `answer`: an answer, `ref` = the ask id, `expires_at` = the delivery's expiry.
 * - `redeliver`: on open, re-send this binding's pending asks (no body — the daemon is the source
 *   of truth, and a re-send reaches only the paired phone).
 */
export const AppCallbackSchema = z.discriminatedUnion('kind', [
  z.object({
    app: z.literal(1),
    kind: z.literal('pair'),
    binding: z.literal(APP_PAIRING_BINDING),
    ref: z.string().min(1).max(64),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
  z.object({
    app: z.literal(1),
    kind: z.literal('answer'),
    binding: z.string().min(1).max(64),
    ref: z.string().min(1).max(128),
    expires_at: z.number().int().nonnegative(),
    sealed: SealedBodySchema,
  }),
  z.object({
    app: z.literal(1),
    kind: z.literal('redeliver'),
    binding: z.string().min(1).max(64),
  }),
]);
export type AppCallback = z.infer<typeof AppCallbackSchema>;

/**
 * What the daemon signs and seals to the phone. `nonce` is unique per token (the phone's seen-nonce
 * store drops a replay before display); `token` is the ADR 623 ask token the answer redeems.
 */
export const AppDeliverySchema = z.discriminatedUnion('kind', [
  z.object({
    v: z.literal(1),
    kind: z.literal('ask'),
    team: z.string(),
    binding: z.string(),
    ask: z.object({
      id: z.string(),
      from: z.string(),
      from_kind: z.enum(['agent', 'human']),
      body: z.string(),
      tier: z.string(),
      species: z.string().nullable(),
      action_class: z.enum(['advisory', 'privileged']),
      ts: z.number().int(),
    }),
    token: z.string(),
    nonce: z.string(),
    expires_at: z.number().int(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal('paired'),
    team: z.string(),
    binding: z.string(),
    member: z.string(),
    device_key_id: z.string(),
  }),
]);
export type AppDelivery = z.infer<typeof AppDeliverySchema>;

/** The phone's answer, opened from a body sealed to the daemon with purpose `answer`. */
export const AppAnswerSchema = z.object({
  v: z.literal(1),
  token: z.string().min(1).max(128),
  decision: z.enum(['approve', 'reject']),
  nonce: z.string().min(1).max(64),
  /** The phone signing key's ECDSA P-256 / SHA-256 signature, DER, over {@link appAnswerSigningBytes}. */
  signature: b64url.max(256),
  /** "I did not expect this" — only on a reject (ADR 676 §8). */
  reported: z.boolean().optional(),
});
export type AppAnswer = z.infer<typeof AppAnswerSchema>;

/**
 * The bytes the phone signs for an answer: domain-separated canonical JSON of everything the answer
 * means, so a signature for one ask, binding, decision or delivery is a signature for no other.
 */
export function appAnswerSigningBytes(input: {
  team: string;
  binding: string;
  ask: string;
  token: string;
  decision: 'approve' | 'reject';
  nonce: string;
  reported: boolean;
}): string {
  return [
    'musterd-app-answer/v1',
    input.team,
    input.binding,
    input.ask,
    input.token,
    input.decision,
    input.nonce,
    input.reported ? 'reported' : '-',
  ].join('\n');
}
