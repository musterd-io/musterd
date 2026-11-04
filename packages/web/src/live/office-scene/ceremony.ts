/**
 * The goal bell's queue (goal bell spec 2026-11-03, lane 01M6HHHA96): one ceremony at a time (nick:
 * "Several goals at once: one ceremony at a time"). Pure — no DOM, no audio — so the tests hold it.
 *
 * - Goals play in the order they shipped, one ceremony each.
 * - A long queue does not freeze the room: past the third waiting, a goal rings the bell alone
 *   (`'strike'`), a strike at least `STRIKE_GAP_MS` after the last.
 * - A goal that waited more than `STALE_MS` is dropped: a tab coming back does not replay a backlog.
 * - The same goal twice plays once.
 */
export const STALE_MS = 30_000;
export const STRIKE_GAP_MS = 2_000;
/** How many may wait for a full ceremony; the rest strike. */
export const FULL_WAITING = 3;

export interface Ceremony {
  goal: string;
  /** Who walks to the bell: the member who recorded the goal as done. */
  ringer: string;
}

export interface Ceremonies {
  push(goal: { id: string; who: string; at: number }): void;
  /** What to play now: a ceremony, a lone strike, or nothing (one is running, or none waits). */
  next(now: number): Ceremony | 'strike' | null;
  /** The running ceremony ended. */
  done(): void;
}

export function createCeremonies(): Ceremonies {
  const waiting: { id: string; who: string; at: number }[] = [];
  const seen = new Set<string>();
  let running = false;
  let lastStrike = -Infinity;
  return {
    push(goal) {
      if (seen.has(goal.id)) return;
      seen.add(goal.id);
      if (seen.size > 200) for (const old of seen) { seen.delete(old); break; }
      waiting.push(goal);
    },
    next(now) {
      while (waiting.length && now - waiting[0]!.at > STALE_MS) waiting.shift();
      if (!waiting.length) return null;
      if (!running) {
        const g = waiting.shift()!;
        running = true;
        return { goal: g.id, ringer: g.who };
      }
      // while one plays, everything past the full-ceremony allowance rings alone, spaced out
      if (waiting.length > FULL_WAITING && now - lastStrike >= STRIKE_GAP_MS) {
        waiting.splice(FULL_WAITING, 1);
        lastStrike = now;
        return 'strike';
      }
      return null;
    },
    done() {
      running = false;
    },
  };
}
