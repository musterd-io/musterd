import type { Lane } from '@musterd/protocol';
import type { Driver } from '../db/driver.js';
import { deriveNext } from './orientation.js';

/**
 * What a seat on shift may take on when its claimed work runs out (ADR 793). The pool and its order
 * are `team_next`'s `up_next` (ADR 536) — the same ranking the seat would read itself — so the
 * recommendation and the seat's own view never disagree.
 */

/** The most lanes one recommendation names. */
export const RECOMMEND_MAX = 3;

/** Up to {@link RECOMMEND_MAX} open lanes for this seat, best first. */
export async function recommendFor(
  db: Driver,
  teamId: string,
  teamSlug: string,
  seat: string,
): Promise<Lane[]> {
  return (await deriveNext(db, teamId, teamSlug, seat, 0, RECOMMEND_MAX)).up_next.slice(
    0,
    RECOMMEND_MAX,
  );
}

/**
 * The lane a seat at `claim` or `free` takes on its own, or null. Never a lane with a risk tag
 * (that one waits for a person, through the recommendation), and at `claim` only a lane attached to
 * one of the goals a person named for the seat.
 */
export function pickAutoClaim(
  ranked: readonly Lane[],
  autonomy: 'ask' | 'claim' | 'free',
  goals: readonly string[] | undefined,
): Lane | null {
  if (autonomy === 'ask') return null;
  for (const lane of ranked) {
    if (lane.risk.length > 0) continue;
    if (autonomy === 'claim' && (lane.goal_id === null || !(goals ?? []).includes(lane.goal_id)))
      continue;
    return lane;
  }
  return null;
}

/**
 * This shift's recommendation, if the seat made one (one per shift): its question, how many lanes it
 * offered, and the answer — `picked` a lane (the seat is about to claim it), `none`, or not yet.
 */
export async function recommendationThisShift(
  db: Driver,
  teamId: string,
  seat: string,
  startedAt: number,
): Promise<{ answer: 'picked' | 'none' | null; answeredAt: number | null } | null> {
  const row = await db.get<{ detail: string }>(
    `SELECT detail FROM audit WHERE team_id = ? AND action = 'shift.recommended' AND target = ?
       AND json_extract(detail, '$.shift_started_at') = ? ORDER BY id DESC LIMIT 1`,
    [teamId, seat, startedAt],
  );
  if (!row) return null;
  const detail = JSON.parse(row.detail) as { question: string; lanes: string[] };
  const answer = await db.get<{ meta: string | null; ts: number }>(
    `SELECT meta, ts FROM messages WHERE team_id = ? AND act = 'accept'
       AND json_extract(meta, '$.in_reply_to') = ? ORDER BY ts ASC LIMIT 1`,
    [teamId, detail.question],
  );
  if (!answer) return { answer: null, answeredAt: null };
  const choice = (JSON.parse(answer.meta ?? '{}') as { answer?: { choice?: number } }).answer
    ?.choice;
  return {
    answer: choice !== undefined && choice < detail.lanes.length ? 'picked' : 'none',
    answeredAt: answer.ts,
  };
}

/** The question a recommendation asks: the lanes, then "none". Labels fit ADR 773's 80 chars. */
export function recommendationQuestion(lanes: readonly Lane[]): {
  text: string;
  why: string;
  options: Array<{ label: string; consequence: string }>;
} {
  return {
    text: 'My claimed lanes are done. Which of these should I take next?',
    why: "I'm on shift with nothing claimed. I won't claim anything on my own; your answer decides.",
    options: [
      ...lanes.map((l) => ({
        label: `${l.title.replace(/\s+/g, ' ').slice(0, 50)} (${l.id})`,
        consequence: 'I claim this lane and start on it.',
      })),
      { label: 'None, end my shift', consequence: 'I go off shift until the next Start.' },
    ],
  };
}
