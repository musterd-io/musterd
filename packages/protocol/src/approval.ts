import { z } from 'zod';

/**
 * The node-free half of human authority (ADR 662 decisions 4–5, ADR 694): the closed list of
 * high-authority acts, the canonical approval descriptor, the bytes a device key signs, and the
 * fixed words an authenticator shows for each act. No `node:` import, so the musterd app (Expo,
 * React Native) renders and signs a descriptor with this same code — the bytes the phone signs and
 * the bytes the daemon verifies come from one source. `authority.ts` re-exports all of it, with the
 * node-only digest helper beside it.
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

/**
 * Canonical JSON: object keys sorted recursively, so a digest means the same bytes everywhere.
 * The payload digest is sha256 hex over the UTF-8 of this string (`payloadDigest` in
 * `authority.ts` on the daemon; the app hashes the same string with its platform's SHA-256).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
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

/** What an authenticator shows above the fold for one descriptor: fixed words, then server fields. */
export interface ApprovalWording {
  /** The approval header. Built only from the act, the payload's fixed enums and the target. */
  headline: string;
  /** "As <actor> on <team>" — whose authority, and where. */
  scope: string;
}

/** A `human_accept` payload the wording knows: a verdict on a lane (`route.ts` builds it). */
function laneVerdict(payload: unknown): 'accept' | 'decline' | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const verdict = (payload as { verdict?: unknown }).verdict;
  return verdict === 'accept' || verdict === 'decline' ? verdict : null;
}

/** The descriptor contract for a human answering a daemon-classified privileged ask. */
export function humanAskAnswerApproval(askId: string, verdict: 'accept' | 'decline') {
  return {
    act: 'human_accept' as const,
    target: askId,
    payload: { ask_id: askId, verdict },
  };
}

/** The descriptor contract for an admin deciding a pending seat request. */
export function requestDecisionApproval(input: {
  requestId: string;
  requestTarget: string | null;
  decision: 'approve' | 'deny';
  lifetime?: 'once' | 'ttl' | 'standing';
  ttlHours?: number;
}) {
  const action =
    input.decision === 'approve'
      ? `approve ${input.requestTarget ?? 'request'}${input.lifetime ? ` (${input.lifetime})` : ''}`
      : `deny ${input.requestTarget ?? 'request'}`;
  return {
    act: 'human_accept' as const,
    target: `request ${input.requestId}: ${action}`,
    payload: {
      request_id: input.requestId,
      request_target: input.requestTarget,
      decision: input.decision,
      ...(input.decision === 'approve'
        ? { lifetime: input.lifetime, ttl_hours: input.ttlHours }
        : {}),
    },
  };
}

/**
 * ADR 676 §6: the app's own fixed wording for each act on the closed list. A `Record` over the list,
 * so a new listed act fails to compile until it has words. Nothing an agent wrote reaches the
 * headline: the target is a server identifier (a lane id, a member name, a team slug) and the
 * verdict is read only as one of two fixed values.
 */
const WORDING: Record<HighAuthorityAct, (target: string, payload: unknown) => string> = {
  human_accept: (target, payload) => {
    const verdict = laneVerdict(payload);
    if (
      typeof payload === 'object' &&
      payload !== null &&
      typeof (payload as { ask_id?: unknown }).ask_id === 'string'
    ) {
      if (verdict === 'accept') return `Answer privileged ask ${target}`;
      if (verdict === 'decline') return `Decline privileged ask ${target}`;
    }
    if (verdict === 'accept') return `Accept lane ${target} as done`;
    if (verdict === 'decline') return `Send lane ${target} back to its owner`;
    return `Give your verdict on ${target}`;
  },
  set_authorized_by: (target) => `Authorize ${target} in your name`,
  'admin.team_policy': (target) => `Change the team policy of ${target}`,
  'admin.roster': (target) => `Change the roster: ${target}`,
  'admin.team_settings': (target) => `Change the team settings of ${target}`,
  grant_issue: (target) => `Issue a grant to ${target}`,
  credential_mint: (target) => `Mint a credential for ${target}`,
  agent_create: (target) => `Create the agent ${target}`,
  device_key_admin: (target) => `Change the device keys of ${target}`,
};

export function approvalWording(d: ApprovalDescriptor, payload: unknown): ApprovalWording {
  return { headline: WORDING[d.act](d.target, payload), scope: `As ${d.actor} on ${d.audience}` };
}
