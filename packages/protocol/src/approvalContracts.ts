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
