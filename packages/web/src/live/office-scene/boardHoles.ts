import { STICKY_CAP, WALL_COLUMNS, type HeldMarks } from './wallboard';

/**
 * The viewer's pin-hole history (lane 01M4VP3V99): which slots on the wall board a card has ever hung in,
 * as a per-team high-water mark per column. Browser storage is a per-viewer convenience here, never a
 * source of truth — private windows and blocked storage throw or come back empty, so every read and write
 * is guarded and the board simply shows no holes until it has seen cards come and go.
 */
const key = (team: string) => `musterd.live.board-held.v1.${team}`;

type Store = Pick<Storage, 'getItem' | 'setItem'>;
const defaultStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** Marks saved for this team, validated to a whole number of slots per known column; `{}` on any trouble. */
export function loadHeld(team: string, store: Store | null = defaultStore()): HeldMarks {
  try {
    const raw = store?.getItem(key(team));
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: HeldMarks = {};
    for (const col of WALL_COLUMNS) {
      const n = (parsed as Record<string, unknown>)[col];
      if (typeof n === 'number' && Number.isInteger(n) && n > 0) out[col] = Math.min(n, STICKY_CAP);
    }
    return out;
  } catch {
    return {};
  }
}

export function saveHeld(team: string, marks: HeldMarks, store: Store | null = defaultStore()): void {
  try {
    store?.setItem(key(team), JSON.stringify(marks));
  } catch {
    /* storage unavailable: the holes live for this page only */
  }
}
