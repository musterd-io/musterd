/**
 * Twitch polls (ADR 807) as plain TypeScript — no zod, so `/broadcast`'s tally card and the stream
 * machine's chat module read a poll without a validator in their bundle. `poll.ts` builds the schemas.
 */

export const POLL_LIMITS = {
  minOptions: 2,
  maxOptions: 4,
  minMinutes: 1,
  maxMinutes: 15,
  defaultMinutes: 5,
  /** Twitch reporting the channel offline this long, straight, closes a poll as `interrupted`. */
  offlineGraceMs: 90_000,
  /** At most one counted vote per viewer per this long. */
  voteGapMs: 2_000,
  questionMax: 200,
  optionMax: 80,
} as const;

/** How a poll ended: its time ran out, an admin ended it early or cancelled it, or the stream dropped. */
export const POLL_ENDS = ['deadline', 'ended', 'cancelled', 'interrupted'] as const;
export type PollEnd = (typeof POLL_ENDS)[number];

/** What an admin writes. Viewers only ever choose among `options`. */
export interface PollSpec {
  question: string;
  options: string[];
  minutes: number;
}

/**
 * What the stream machine reports — integers, plus two booleans it observes itself. Nothing from a
 * chat message: no viewer, no name, no text (ADR 807 §1).
 */
export interface PollCounts {
  poll_id: string;
  counts: number[];
  voters: number;
  live: boolean;
  post_failed: boolean;
}

/** The open poll, as `GET /polls/open` returns it. `poll_token` reaches the broadcast seat alone. */
export interface OpenPoll extends PollSpec {
  id: string;
  opened_by: string;
  opened_at: number;
  closes_at: number;
  counts: number[];
  voters: number;
  post_failed: boolean;
  poll_token?: string | undefined;
}

export interface OpenPollReply {
  /** Twitch reported the channel live within the offline grace. */
  live: boolean;
  poll: OpenPoll | null;
}

interface PollMetaBase {
  id: string;
  question: string;
  options: string[];
  opened_by: string;
  opened_at: number;
  closes_at: number;
}

/** `meta.poll` on the daemon's two record acts (ADR 807 §9). */
export type PollMeta =
  | (PollMetaBase & { state: 'open' })
  | (PollMetaBase & {
      state: 'closed';
      counts: number[];
      voters: number;
      end: PollEnd;
      /** Option indexes: none (no votes, or cancelled), one, or several for a tie. */
      winners: number[];
      closed_at: number;
    });

/** The option indexes with the most votes — empty when nobody voted. */
export function winnersOf(counts: readonly number[]): number[] {
  const top = Math.max(0, ...counts);
  if (top === 0) return [];
  return counts.flatMap((c, i) => (c === top ? [i] : []));
}
