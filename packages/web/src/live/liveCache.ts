import type { Envelope, LaneBoard, MemberSummary } from '@musterd/protocol';

/**
 * What /live last showed this browser for one team and seat, painted the moment the page opens and
 * replaced as soon as the daemon answers (lane 01M4RNBNFM). nick, 2026-10-12: /live took 5–10 s to
 * show anyone; measured, every read waited 3–4.4 s on a busy daemon while the panels said "0
 * working" and "no open questions". A stale picture marked as refreshing beats a false empty one.
 *
 * Per viewer and per browser, in localStorage: it holds only what this viewer was already shown.
 * Every access is guarded — private windows and blocked storage simply start empty, as before.
 */
export interface LiveSnapshot {
  roster: MemberSummary[];
  envelopes: Envelope[];
  board: LaneBoard | null;
}

const key = (team: string, as: string) => `musterd.live.v1:${team}:${as}`;
/** Parsed once per page: the stream and the board both seed from it on the same mount. */
const read = new Map<string, LiveSnapshot | null>();

export function loadSnapshot(team: string, as: string): LiveSnapshot | null {
  const k = key(team, as);
  if (!read.has(k)) {
    let snap: LiveSnapshot | null = null;
    try {
      const v = JSON.parse(localStorage.getItem(k) ?? 'null') as LiveSnapshot | null;
      if (v && Array.isArray(v.roster) && Array.isArray(v.envelopes)) snap = v;
    } catch {
      /* unreadable or blocked: start empty */
    }
    read.set(k, snap);
  }
  return read.get(k)!;
}

/** The newest envelopes kept: enough for the ticker, the asks and the meter, small enough to write. */
const KEEP = 120;

export function saveSnapshot(team: string, as: string, snap: LiveSnapshot): void {
  // Only the lanes still in play: the full board is every lane ever (227 KB measured 2026-10-12).
  // A tour lane is kept whatever its state, since the tour's entry point reads the closed one.
  const board = snap.board && {
    ...snap.board,
    lanes: snap.board.lanes.filter(
      (l) => !['done', 'abandoned'].includes(l.state) || l.title.startsWith('[tour]'),
    ),
  };
  try {
    localStorage.setItem(
      key(team, as),
      JSON.stringify({ ...snap, envelopes: snap.envelopes.slice(-KEEP), board }),
    );
  } catch {
    /* full or blocked: the next visit loads the slow way */
  }
}

/** Signing out takes this seat's snapshot with it: the next person at this browser sees none of it. */
export function clearSnapshot(team: string, as: string): void {
  read.delete(key(team, as));
  try {
    localStorage.removeItem(key(team, as));
  } catch {
    /* blocked storage holds nothing to clear */
  }
}
