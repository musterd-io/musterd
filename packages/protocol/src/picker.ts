/**
 * ADR 624 — the lane picker's one list. Every front end (the terminal picker, the plain table,
 * /live) renders this and nothing else, so what a human picks from is the board, never a seat's
 * selection of it. Blocked is read from the board's own `unmet_dependency` warnings: the daemon
 * already decided what "met" means (a dependency the board omits under ADR 534's window counts as
 * met), and this must not decide it a second way.
 */
import type { Lane, LaneDeclined, LaneWarning } from './lanes.js';

export interface PickerRow {
  /** Full lane id. */
  id: string;
  /** The first 10 characters, as the board prints them. */
  short: string;
  title: string;
  detail: string | null;
  goal_id: string | null;
  areas: string[];
  risk: string[];
  scope: string[];
  /** `now - created_at`, never negative. */
  age_ms: number;
  /** The unmet dependencies; `[]` means claimable. */
  blocked_on: Array<{ lane: string; owner: string | null; detail: string }>;
  declined: LaneDeclined | null;
}

export interface PickerGroup {
  goal: string | null;
  rows: PickerRow[];
}

export interface PickerView {
  seat: string;
  claimable: PickerGroup[];
  blocked: PickerGroup[];
  /** Short ids of the lanes the seat already holds (claimed, active or blocked). */
  carrying: string[];
}

const HELD = new Set(['claimed', 'active', 'blocked']);

export function pickerRows(
  board: { lanes: readonly Lane[]; warnings: readonly LaneWarning[] },
  seat: string,
  now: number,
): PickerView {
  const unmet = new Map<string, PickerRow['blocked_on']>();
  for (const w of board.warnings) {
    if (w.kind !== 'unmet_dependency') continue;
    const list = unmet.get(w.subject) ?? [];
    list.push({ lane: w.with, owner: w.owner, detail: w.detail });
    unmet.set(w.subject, list);
  }
  const rows = board.lanes
    .filter((l) => l.state === 'open' && l.owner_seat === null)
    .slice()
    .sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id))
    .map(
      (l): PickerRow => ({
        id: l.id,
        short: l.id.slice(0, 10),
        title: l.title,
        detail: l.detail,
        goal_id: l.goal_id,
        areas: l.areas ?? [],
        risk: l.risk ?? [],
        scope: l.scope,
        age_ms: Math.max(0, now - l.created_at),
        blocked_on: unmet.get(l.id) ?? [],
        declined: l.declined ?? null,
      }),
    );
  return {
    seat,
    claimable: group(rows.filter((r) => r.blocked_on.length === 0)),
    blocked: group(rows.filter((r) => r.blocked_on.length > 0)),
    carrying: board.lanes
      .filter((l) => l.owner_seat === seat && HELD.has(l.state))
      .map((l) => l.id.slice(0, 10)),
  };
}

/** Goals alphabetically, the goalless group last; row order is kept. */
function group(rows: PickerRow[]): PickerGroup[] {
  const by = new Map<string | null, PickerRow[]>();
  for (const r of rows) by.set(r.goal_id, [...(by.get(r.goal_id) ?? []), r]);
  return [...by.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([goal, rs]) => ({ goal, rows: rs }));
}

/** Every word must appear in the row's id, title, goal or areas, case-insensitively. Groups left
 *  empty are dropped; blank text returns the view unchanged. */
export function filterPicker(view: PickerView, text: string): PickerView {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return view;
  const hit = (r: PickerRow): boolean => {
    const hay = [r.id, r.title, r.goal_id ?? '', ...r.areas].join(' ').toLowerCase();
    return words.every((w) => hay.includes(w));
  };
  const keep = (gs: PickerGroup[]): PickerGroup[] =>
    gs.map((g) => ({ ...g, rows: g.rows.filter(hit) })).filter((g) => g.rows.length > 0);
  return { ...view, claimable: keep(view.claimable), blocked: keep(view.blocked) };
}
