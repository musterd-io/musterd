import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * Human authority (ADR 662, lane 01M5ANFFVHY07ZTYEECTRSTXTN). Decision 4's closed list of
 * high-authority acts, and decision 5's canonical approval descriptor: the server builds it,
 * a device key bound to the human signs it, and the act is accepted only with that signature —
 * on every transport. A Bearer [REDACTED] an agent can read, a Slack HMAC (A1) or a button tap
 * stays advisory for every act on this list.
 *
 * Activation (nick, 2026-10-19): refusal is per-human. An agent-kind credential is refused for
 * a listed act outright; a human's listed acts require A2 once that human has an enrolled
 * device key. The ADR 200 gate closes when lanes 1–3 have landed and humans are enrolled.
 */

/** Decision 4's closed list. Widening or narrowing it is a reviewed protocol change. */
export const HIGH_AUTHORITY_ACTS = [
  /** A human's accept or decline wherever it counts as human acceptance or a human answer
   * (ADR 192, ADR 603, ADR 127 `request.decide`, a gate release under ADR 150). */
  'human_accept',
  /** Anything that sets `authorized_by`. */
  'set_authorized_by',
  /** Admin: team policy. */
  'admin.team_policy',
  /** Admin: roster changes and member removal. */
  'admin.roster',
  /** Admin: team settings. */
  'admin.team_settings',
  /** Grants (ADR 146). */
  'grant_issue',
  /** Minting any credential or key, a sponsor host key included (ADR 463, ADR 648). */
  'credential_mint',
  /** Creating an agent (ADR 459). */
  'agent_create',
  /** Enrolling, revoking or recovering a device key (decision 6; lane 2 builds the flow). */
  'device_key_admin',
] as const;
export type HighAuthorityAct = (typeof HIGH_AUTHORITY_ACTS)[number];

export function isHighAuthorityAct(v: unknown): v is HighAuthorityAct {
  return typeof v === 'string' && (HIGH_AUTHORITY_ACTS as readonly string[]).includes(v);
}

/** Why a listed act was refused (ADR 662, Observability). Written to `authority.refused`. */
export const AUTHORITY_REFUSAL_REASONS = [
  'no_signature',
  'assurance_too_low',
  'descriptor_mismatch',
  'expired',
  'nonce_reused',
  'key_revoked',
  'agent_credential',
] as const;
export type AuthorityRefusalReason = (typeof AUTHORITY_REFUSAL_REASONS)[number];

/**
 * The authenticators of decision 5, plus `software` — an honestly recorded kind for a
 * key whose private half lives in a file any same-user process can read. It may be
 * enrolled (behind a standing key's signature) but `requireAuthority` never accepts
 * it as A2 (decision 5: a key reachable by any node process does not qualify); it is
 * never spelled `platform`, which is reserved for the Secure Enclave helper's key.
 */
export const AUTHENTICATOR_KINDS = ['platform', 'passkey', 'phone', 'software'] as const;
export type AuthenticatorKind = (typeof AUTHENTICATOR_KINDS)[number];

/** Canonical JSON: object keys sorted recursively, so a digest means the same bytes everywhere. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** sha256 hex of the canonical payload — what the descriptor commits the signature to. */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}

/**
 * The canonical approval descriptor (decision 5). Built by the server from the act being
 * attempted — never from wording the caller supplies — and rendered by the authenticator
 * from this server data, so the prompt a human approves cannot be worded by an agent.
 */
export const ApprovalDescriptorSchema = z.object({
  v: z.literal(1),
  /** The human whose authority the act exercises (member name). */
  actor: z.string().min(1),
  act: z.enum(HIGH_AUTHORITY_ACTS),
  /** What the act acts on (a lane id, a team slug, a member name — act-specific). */
  target: z.string().min(1),
  /** sha256 hex of the canonical act payload. */
  payload_digest: z.string().regex(/^[0-9a-f]{64}$/),
  /** The team the signature is for; a signature never crosses teams. */
  audience: z.string().min(1),
  /** Unix ms after which the descriptor is dead. */
  expiry: z.number().int().positive(),
  /** One-use nonce, minted by the server with the descriptor. */
  nonce: z.string().min(16),
});
export type ApprovalDescriptor = z.infer<typeof ApprovalDescriptorSchema>;

/** The exact bytes a device key signs. Versioned so the format can grow a v2 beside it. */
export function descriptorSigningBytes(d: ApprovalDescriptor): string {
  return [
    'musterd-approval/v1',
    d.actor,
    d.act,
    d.target,
    d.payload_digest,
    d.audience,
    String(d.expiry),
    d.nonce,
  ].join('\n');
}

/**
 * A presented proof: which key, over which descriptor nonce, signed how (base64url).
 * Platform and phone keys sign the descriptor's signing bytes directly. A passkey signs
 * the WebAuthn assertion instead, so its proof also carries the authenticator data and
 * client data (base64url / utf8) the server needs to check the challenge and origin.
 */
export const ApprovalProofSchema = z.object({
  key_id: z.string().min(1),
  nonce: z.string().min(16),
  signature: z.string().min(1),
  authenticator_data: z.string().min(1).optional(),
  client_data_json: z.string().min(1).optional(),
});
export type ApprovalProof = z.infer<typeof ApprovalProofSchema>;
