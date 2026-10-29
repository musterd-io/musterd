import type { Envelope } from '@musterd/protocol';

/**
 * What is waiting at a member's desk right now (lane 01M5XS6ARW, swetha 2026-10-28: "desks that
 * reflect now, not history"). Each one is a thing someone would act on; it appears when it starts
 * and clears when it ends. Nothing here counts tenure or output — a score on a desk was the version
 * this replaced, and agents out-ship humans, so it would only ever say the wrong thing.
 *
 * - `blocked` — a sticky note on the monitor: the member owns a blocked lane.
 * - `handoff` — a folder at the desk's edge: a `handoff` act to them, not yet answered.
 * - `review` — a tray with a card: open `lane_review` asks routed to them (ADR 192).
 *
 * One per desk, in that order — a blocked desk is the owner's own stop; a handoff is waiting on
 * them to pick something up; a review is the gentlest. The desk is the item's home, not the body:
 * the prop stays put while its member is away, because that is exactly when it is worth seeing.
 */
export type DeskWaiting =
  | { kind: 'blocked' }
  | { kind: 'handoff'; from: string }
  | { kind: 'review'; count: number };

/** A handoff nobody answered for a day is stale, not waiting — the daemon sweeps lanes on the same horizon. */
export const HANDOFF_STALE_MS = 24 * 60 * 60 * 1000;

/** Answer acts that settle a handoff, when its recipient sends one referencing it. */
const ANSWERS = new Set(['accept', 'decline', 'resolve']);

function refs(env: Envelope, id: string, thread: string | null | undefined): boolean {
  const meta = env.meta ?? {};
  if (meta['in_reply_to'] === id || meta['ask_ref'] === id) return true;
  return env.thread != null && (env.thread === id || env.thread === thread);
}

/**
 * Unanswered `handoff` acts, recipient → the newest one's sender. Answered means the recipient sent
 * an accept / decline / resolve that references it; a later handoff of the same thread from anyone
 * else does not settle it.
 */
export function openHandoffs(envelopes: readonly Envelope[], now: number): Map<string, string> {
  const open = new Map<string, { from: string; ts: number }>();
  const sorted = [...envelopes].sort((a, b) => a.ts - b.ts);
  const pending: Envelope[] = [];
  for (const env of sorted) {
    if (env.act === 'handoff' && env.to.kind === 'member' && env.to.name !== env.from) {
      pending.push(env);
      continue;
    }
    if (!ANSWERS.has(env.act)) continue;
    for (let i = pending.length - 1; i >= 0; i--) {
      const h = pending[i]!;
      if (h.to.kind === 'member' && h.to.name === env.from && refs(env, h.id, h.thread)) pending.splice(i, 1);
    }
  }
  for (const h of pending) {
    if (h.to.kind !== 'member' || now - h.ts > HANDOFF_STALE_MS) continue;
    const had = open.get(h.to.name);
    if (!had || h.ts >= had.ts) open.set(h.to.name, { from: h.from, ts: h.ts });
  }
  return new Map([...open].map(([to, h]) => [to, h.from]));
}

/** The one prop a desk shows, by priority — or null for a desk with nothing waiting. */
export function deskWaitingFor(
  name: string,
  blocked: boolean,
  handoffs: ReadonlyMap<string, string>,
  reviews: ReadonlyMap<string, number>,
): DeskWaiting | null {
  if (blocked) return { kind: 'blocked' };
  const from = handoffs.get(name);
  if (from !== undefined) return { kind: 'handoff', from };
  const count = reviews.get(name) ?? 0;
  return count > 0 ? { kind: 'review', count } : null;
}

/** The plate's words for it — a prop alone is a picture, and the room is read by people too. */
export function deskWaitingLine(w: DeskWaiting): string {
  switch (w.kind) {
    case 'blocked':
      return 'blocked';
    case 'handoff':
      return `handoff from ${w.from}`;
    case 'review':
      return w.count === 1 ? '1 to review' : `${w.count} to review`;
  }
}

/** A stable string for the desk sprite's key: the prop changes the baked desk, nothing else does. */
export function deskWaitingKey(w: DeskWaiting | null | undefined): string {
  if (!w) return '';
  return w.kind === 'review' ? `review${Math.min(w.count, 9)}` : w.kind;
}
