/**
 * When the Now briefing comes up by itself, and how it remembers.
 *
 * It is the page a member reads when they sit down and have forgotten yesterday, so it opens as an
 * overlay on the first visit of a *period* and then gets out of the way: docked to a side tab, one
 * click from being back. Opening it on every reload would turn a briefing into a nag; never opening
 * it would hide the thing the page is for. The period is a working day's length — a morning visit
 * and an afternoon one are the same sitting, tomorrow's is not.
 *
 * Browser storage is a per-viewer convenience here, and it can be absent or throw (a private
 * window): every read and write is guarded, and the briefing opens as if it were a first visit.
 */

/** The three places the briefing can be. */
export type NowMode = 'overlay' | 'docked' | 'full';

/** Eight hours: a morning and the afternoon after it are one sitting. */
export const NOW_PERIOD_MS = 8 * 60 * 60 * 1000;

export const NOW_KEY = 'musterd.live.now-briefed-at';

/** A minimal storage so a test can pass its own. */
export interface NowStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** When the briefing last opened by itself, or null (never, unreadable, or nonsense). */
export function readBriefedAt(storage: NowStorage | null): number | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(NOW_KEY);
    if (raw === null) return null;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

export function writeBriefedAt(storage: NowStorage | null, at: number): void {
  if (!storage) return;
  try {
    storage.setItem(NOW_KEY, String(at));
  } catch {
    /* private mode — the next visit simply opens it again */
  }
}

/**
 * Where the briefing starts on a page load. `overlay` only when this is the first visit of a
 * period; otherwise `docked`. A phone never auto-opens: the overlay would cover the one column it
 * has, and a phone's first visit should not spend the period on a screen too small to read it.
 */
export function startMode(
  briefedAt: number | null,
  now: number,
  opts: { phone: boolean },
): { mode: NowMode; opened: boolean } {
  if (opts.phone) return { mode: 'docked', opened: false };
  const due = briefedAt === null || now - briefedAt >= NOW_PERIOD_MS || now < briefedAt;
  return due ? { mode: 'overlay', opened: true } : { mode: 'docked', opened: false };
}
