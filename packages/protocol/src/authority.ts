import { createHash } from 'node:crypto';
import { canonicalJson } from './approval.js';

export {
  ApprovalDescriptorSchema,
  ApprovalProofSchema,
  approvalWording,
  canonicalJson,
  descriptorSigningBytes,
  HIGH_AUTHORITY_ACTS,
  isHighAuthorityAct,
  type ApprovalDescriptor,
  type ApprovalProof,
  type ApprovalWording,
  type HighAuthorityAct,
} from './approval.js';

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

/** sha256 hex of the canonical payload — what the descriptor commits the signature to. */
export function payloadDigest(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload), 'utf8').digest('hex');
}
