import type { Envelope } from '@musterd/protocol';

/**
 * ADR 769: which vouch requests wait on this admin. Pure and import-light (types only), so /live's
 * eager graph can light the settings dot without carrying the vouch ceremony, which lives in
 * `vouch.ts` in the settings sheet's lazy chunk.
 */

/** A held enrollment lives as long as its enrollment code: ten minutes (ADR 662 decision 6). */
export const VOUCH_TTL_MS = 10 * 60_000;

export interface VouchRequest {
  /** The request_help's id: the thread the admin's resolve answers on. */
  id: string;
  member: string;
  digest: string;
  ts: number;
}

const DIGEST = /^[0-9a-f]{64}$/;

function vouchMeta(env: Envelope): { member: string; digest: string } | null {
  const v = env.meta?.['vouch'];
  if (typeof v !== 'object' || v === null) return null;
  const { member, enrollment_digest } = v as { member?: unknown; enrollment_digest?: unknown };
  if (typeof member !== 'string' || typeof enrollment_digest !== 'string') return null;
  if (!DIGEST.test(enrollment_digest)) return null;
  return { member, digest: enrollment_digest };
}

/**
 * The vouch requests waiting on `me`: a `request_help` addressed to me, from a human, whose
 * `meta.vouch.member` is its own sender (a member only ever asks for themself; `from` is stamped by
 * the daemon, the meta is not), not yet answered by me on its thread, and younger than the held
 * enrollment. One per member: a newer request replaces an older one. Pure, so it is testable.
 */
export function pendingVouches(
  envelopes: readonly Envelope[],
  me: string,
  humans: ReadonlySet<string>,
  now: number,
): VouchRequest[] {
  const answered = new Set(
    envelopes
      .filter((e) => e.from === me && e.thread && ['resolve', 'decline', 'accept'].includes(e.act))
      .map((e) => e.thread as string),
  );
  const byMember = new Map<string, VouchRequest>();
  for (const e of envelopes) {
    if (e.act !== 'request_help' || e.to.kind !== 'member' || e.to.name !== me) continue;
    if (!humans.has(e.from) || e.from === me) continue;
    const v = vouchMeta(e);
    if (!v || v.member !== e.from) continue;
    if (now - e.ts > VOUCH_TTL_MS || answered.has(e.id)) continue;
    const prev = byMember.get(v.member);
    if (!prev || prev.ts < e.ts) byMember.set(v.member, { id: e.id, ...v, ts: e.ts });
  }
  return [...byMember.values()].sort((a, b) => a.ts - b.ts);
}

