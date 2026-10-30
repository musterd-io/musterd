import { filterPicker, type PickerRow, type PickerView } from '@musterd/protocol';
import type { Key } from '../launcher/picker/state.js';

/** The lane picker's state (ADR 624). `view` is the unfiltered board; the filter applies on read. */
export interface PickState {
  team: string;
  seat: string;
  view: PickerView;
  filter: string;
  tab: 'claimable' | 'blocked';
  /** Index into {@link visibleRows}. */
  cursor: number;
  /** One line under the header: a refusal, a "blocked on", a "taken by". Cleared by the next key. */
  notice: string | null;
  now: number;
}

/** `board`: a fresh read (on open, or after a pick was refused because the lane moved). */
export type PickEvent = { type: 'board'; view: PickerView; now: number; notice?: string };

export type PickOutcome = { kind: 'pick'; row: PickerRow } | { kind: 'quit'; code: number };

type Step = { state: PickState; outcome: PickOutcome | null };

export function initialPick(team: string, seat: string, view: PickerView, now: number): PickState {
  return { team, seat, view, filter: '', tab: 'claimable', cursor: 0, notice: null, now };
}

/** The rows the cursor walks: the current tab, filtered, group order kept. */
export function visibleRows(s: PickState): PickerRow[] {
  return filterPicker(s.view, s.filter)[s.tab].flatMap((g) => g.rows);
}

function clamp(s: PickState): PickState {
  const n = visibleRows(s).length;
  return { ...s, cursor: n === 0 ? 0 : Math.min(Math.max(0, s.cursor), n - 1) };
}

export function reducePick(s: PickState, e: PickEvent | { type: 'key'; key: Key }): Step {
  if (e.type === 'board')
    return {
      state: clamp({ ...s, view: e.view, now: e.now, notice: e.notice ?? null }),
      outcome: null,
    };
  const k = e.key;
  const quiet = { ...s, notice: null };
  if (k.ctrl && k.name === 'c') return { state: s, outcome: { kind: 'quit', code: 130 } };
  switch (k.name) {
    case 'escape':
      return { state: s, outcome: { kind: 'quit', code: 0 } };
    case 'up':
      return { state: clamp({ ...quiet, cursor: s.cursor - 1 }), outcome: null };
    case 'down':
      return { state: clamp({ ...quiet, cursor: s.cursor + 1 }), outcome: null };
    case 'tab':
      return {
        state: clamp({ ...quiet, tab: s.tab === 'claimable' ? 'blocked' : 'claimable', cursor: 0 }),
        outcome: null,
      };
    case 'backspace':
      return {
        state: clamp({ ...quiet, filter: s.filter.slice(0, -1), cursor: 0 }),
        outcome: null,
      };
    case 'return':
    case 'enter': {
      const row = visibleRows(s)[s.cursor];
      if (!row) return { state: s, outcome: null };
      if (row.blocked_on.length > 0) {
        const b = row.blocked_on[0]!;
        return {
          state: {
            ...s,
            notice: `blocked on ${b.lane.slice(0, 10)} (owner ${b.owner ?? 'unowned'}) — it stays viewable while blocked`,
          },
          outcome: null,
        };
      }
      return { state: s, outcome: { kind: 'pick', row } };
    }
  }
  const ch = k.sequence;
  if (!k.ctrl && !k.meta && ch !== undefined && ch.length === 1 && ch >= ' ' && ch !== '\x7f')
    return { state: clamp({ ...quiet, filter: s.filter + ch, cursor: 0 }), outcome: null };
  return { state: s, outcome: null };
}
