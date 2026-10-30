/**
 * The doorbell's validator-free half (ADR 443): the sink vocabulary and the ring rule, plain
 * TypeScript so `/live` can ask "does this act ring me?" without pulling zod into the bundle. The
 * zod module (`doorbell.ts`) builds its enum from this tuple and re-exports every name here.
 */

import { eligibleOf } from './envelope.wire.js';

/** The four sinks, in route order. `live` is always on (ADR 443 §3). */
export const DOORBELL_SINKS = ['live', 'os', 'slack', 'webhook'] as const;
export type DoorbellSink = (typeof DOORBELL_SINKS)[number];

/** The sinks the daemon POSTs to — the off-machine ones ADR 155's present-admin quiet applies to. */
export const OFF_MACHINE_SINKS: ReadonlySet<DoorbellSink> = new Set(['slack', 'webhook']);

/** The acts that ring a human when **directed** to one (spec §1). */
const DIRECTED_RINGS = new Set(['ask', 'request_help', 'handoff']);

/** Can this act ring anyone at all? The cheap pre-check before {@link ringTargets} reads members. */
export function actMayRing(act: string): boolean {
  return DIRECTED_RINGS.has(act);
}

/**
 * Which human members this act rings (ADR 443 §2):
 * - a directed `ask`, `request_help` or `handoff` to a human rings that human;
 * - any other `ask` — team-addressed, or directed to an agent — rings every **admin** human (ADR
 *   147 routing), never every human;
 * - a `lane_review` acceptance ask rings only when directed to a human: between agents it is peer
 *   review, and team-addressed it waits on `/live` like `request_help` and `handoff`;
 * - nothing else rings, and nothing a dream sends rings at all (ADR 494 §4).
 */
export function ringTargets(input: {
  act: string;
  /** The directed recipient's name, or null for a team/broadcast address. */
  to: string | null;
  meta: Record<string, unknown> | null | undefined;
  humans: ReadonlySet<string>;
  admins: ReadonlySet<string>;
  /** The sending session's provenance. `dream` rings no one, whatever the act (ADR 494 §4). */
  from_provenance?: string | null;
}): string[] {
  const { act, to, meta, humans, admins } = input;
  if (input.from_provenance === 'dream') return [];
  if (!DIRECTED_RINGS.has(act)) return [];
  if (to !== null && humans.has(to)) return [to];
  if (act !== 'ask' || isLaneReview(meta)) return [];
  return [...admins].filter((name) => humans.has(name));
}

function isLaneReview(meta: Record<string, unknown> | null | undefined): boolean {
  const review = meta?.['lane_review'];
  return typeof review === 'object' && review !== null;
}

/** The acts that ring an idle session when directed to its seat (idle-wake spec §1, ADR 558). */
const IDLE_RINGS = new Set(['steer', 'ask', 'request_help', 'handoff']);

/** The envelope fields the idle rule reads — structural, so `/live` and the adapter can call it. */
export interface IdleRingInput {
  act: string;
  from: string;
  to: { kind: string; name?: string };
  meta?: Record<string, unknown> | null | undefined;
  thread?: string | null | undefined;
}

/**
 * Does this act ring `seat`'s idle session (ADR 558 §1)? Directed — to the seat, or an eligible set
 * naming it — and either flagged urgent or one of the four acts that ask the seat to do something.
 * A team-addressed act never rings an idle session; huddle turns ring through the live set's
 * membership rule on the daemon, which an envelope alone cannot decide.
 */
export function idleRingable(env: IdleRingInput, seat: string): boolean {
  if (env.from === seat) return false;
  const named = eligibleOf(env.meta);
  const directed = named ? named.includes(seat) : env.to.kind === 'member' && env.to.name === seat;
  if (!directed) return false;
  // ADR 645 §4.3: a band-2 pull announcement sits in the opener's inbox but is excluded from wake
  // triggers — an idle opener (mostly an agent) must not pay a turn for every advisory pull.
  if (env.act === 'ask' && isPullAnnouncement(env.meta)) return false;
  if (env.meta?.['urgent'] === true) return true;
  // ADR 773 §7: the answer to the seat's question rings it — the one `accept` that does.
  if (isQuestionAnswer(env)) return true;
  // ADR 779 §4: the hub's PR watch telling a lane's owner its PR merged or went red.
  if (isPrEvent(env)) return true;
  return IDLE_RINGS.has(env.act);
}

/** ADR 773: an `accept` carrying a question's answer and the server's proof of it. */
export function isQuestionAnswer(env: Pick<IdleRingInput, 'act' | 'meta'>): boolean {
  if (env.act !== 'accept') return false;
  const meta = env.meta;
  return (
    typeof meta?.['answer'] === 'object' &&
    meta['answer'] !== null &&
    typeof meta['answer_proof'] === 'object' &&
    meta['answer_proof'] !== null
  );
}

/** ADR 645: the host's service seat stamps `meta.pull` on the announcement ask. */
export function isPullAnnouncement(meta: Record<string, unknown> | null | undefined): boolean {
  const pull = meta?.['pull'];
  return typeof pull === 'object' && pull !== null;
}

/** The adapter's cheap pre-filter: {@link idleRingable}, or any threaded act (a possible huddle
 *  turn) — the daemon's `seam=idle` read is the authority for both. */
export function idleMayRing(env: IdleRingInput, seat: string): boolean {
  return idleRingable(env, seat) || (env.from !== seat && env.thread != null);
}

/** ADR 779 §4: the PR watch's `message` (server-controlled `meta.pr_event`; a client copy is stripped). */
export function isPrEvent(env: Pick<IdleRingInput, 'act' | 'meta'>): boolean {
  const ev = env.meta?.['pr_event'];
  return env.act === 'message' && typeof ev === 'object' && ev !== null;
}
