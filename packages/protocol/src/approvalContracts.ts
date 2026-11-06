/**
 * Small, schema-free builders for approval descriptors. Keep these separate from the Zod
 * definitions in approval.ts so browser callers that only build a descriptor do not bundle Zod.
 */
export function humanAskAnswerApproval(askId: string, verdict: 'accept' | 'decline') {
  return {
    act: 'human_accept' as const,
    target: askId,
    payload: { ask_id: askId, verdict },
  };
}

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
 * ADR 769: the six-digit check code for a passkey vouch. The member's sheet shows it, the admin
 * types it on /live, and the phone works it out again from the signed `key`. One function, so the
 * three surfaces cannot disagree. It lives in this schema-free module so /live imports it without
 * Zod; `approval.ts` re-exports it. `digest` is the held enrollment's 64-hex sha256.
 */
export function vouchCheckCode(digest: string): string {
  if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error('vouchCheckCode: digest must be 64 hex');
  return (Number.parseInt(digest.slice(0, 8), 16) % 1_000_000).toString().padStart(6, '0');
}
