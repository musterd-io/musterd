import type { UpdateLane } from '@musterd/protocol';
import { filterPicker, type PickerRow, type PickerView } from '@musterd/protocol/wire';

/**
 * The /live lane picker's state (lane 01M5162T6H, musterd pick spec §5.4). Pure: the overlay keeps
 * this and renders from it, so the keys are tested without a DOM. The rows come from `pickerRows`,
 * the same function the terminal picker and the plain-text fallback call, so the three can never
 * show different lists — and no seat writes or filters them.
 */
export interface PickState {
  tab: 'claimable' | 'blocked';
  filter: string;
  /** Index into `pickItems` for the current tab and filter. */
  cursor: number;
}

/** The rows the list shows, in board order: the tab's groups, filtered, flattened. */
export function pickItems(view: PickerView, s: PickState): PickerRow[] {
  return filterPicker(view, s.filter)[s.tab].flatMap((g) => g.rows);
}

/** One keystroke, or a new filter text. `count` is how many rows the current list has. */
export function pickKey(
  s: PickState,
  key: 'ArrowUp' | 'ArrowDown' | 'Home' | 'End' | 'Tab' | { filter: string },
  count: number,
): PickState {
  if (typeof key === 'object') return { ...s, filter: key.filter, cursor: 0 };
  const last = Math.max(0, count - 1);
  switch (key) {
    case 'ArrowDown':
      return { ...s, cursor: Math.min(last, s.cursor + 1) };
    case 'ArrowUp':
      return { ...s, cursor: Math.max(0, s.cursor - 1) };
    case 'Home':
      return { ...s, cursor: 0 };
    case 'End':
      return { ...s, cursor: last };
    case 'Tab':
      return { ...s, tab: s.tab === 'claimable' ? 'blocked' : 'claimable', cursor: 0 };
  }
}

/** What the seat reads in the handoff act: who picked, where, and what to do next (spec decision 6). */
export function pickNote(by: string): string {
  return `${by} picked this lane for you in /live — reply with a short plan, then start`;
}

/**
 * A /live pick is the existing handoff from the signed-in human to the seat (spec §5.5): no wire
 * change, and the record says the human asked, authenticated. A blocked lane has no patch — the
 * overlay shows what it waits on instead.
 */
export function pickPatch(row: PickerRow, seat: string, by: string): UpdateLane | null {
  if (row.blocked_on.length > 0) return null;
  return { owner_seat: seat, handoff_note: pickNote(by) };
}

/** A lane's age as the list says it: "just now", "12m", "5h", "3d". */
export function pickAge(ms: number): string {
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`;
  return `${Math.floor(ms / 86_400_000)}d`;
}

/** Why a blocked lane cannot be picked yet: each unmet dependency and who holds it. */
export function pickBlockedReason(row: PickerRow): string {
  return row.blocked_on
    .map((b) => `${b.lane.slice(0, 10)}${b.owner ? ` (${b.owner})` : ' (unowned)'}`)
    .join(', ');
}
