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

/**
 * What a pick asks of the seat (spec 2026-10-16 decision 6, §5.7, §10; lane 01M5162W38). Both ways
 * in end with it, and the musterd skill's "When a human picks a lane for you" section explains it:
 * a short plan, then work, with no wait for a yes. A decline is a release with a reason.
 */
export const PICK_ASK = 'Reply with a 3–5 line plan, then start unless redirected.';

/** The words both pick texts share, so a seat (and the skill) can tell a pick from a plain handoff. */
export const PICK_PHRASE = 'picked this lane for you in the lane picker';

/** The note on a /live pick's handoff act (spec §5.5, §10). The human is signed in, so the act is
 *  theirs; the lane title is already on the handoff line, so the note does not repeat it. */
export function pickHandoffNote(by: string): string {
  return `${by} ${PICK_PHRASE} (/live, signed in). ${PICK_ASK}`;
}

/** The line a terminal pick's workspace marker shows once at the seat's interrupt check (ADR 626
 *  Decision 2, which fixes this wording). The pick is the seat's own claim, so it says unattested. */
export function terminalPickNotice(p: { requested_by: string; title: string }): string {
  return `${p.requested_by} ${PICK_PHRASE} (terminal, unattested): "${p.title}". ${PICK_ASK}`;
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
