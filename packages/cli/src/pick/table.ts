import type { PickerGroup, PickerView } from '@musterd/protocol';
import { age, clean } from './text.js';
import { MIN_COLS } from './view.js';

/**
 * The lane picker without a terminal (spec §5.3): what an agent's shell tool gets when it runs
 * `musterd pick`. The same rows as the screen, plain text, full ids so the reader can act on one.
 * It is the board, not anyone's selection of it.
 */
export function renderPickTable(view: PickerView, team: string): string[] {
  const n = (gs: PickerGroup[]) => gs.reduce((a, g) => a + g.rows.length, 0);
  const out = [
    `musterd pick — ${clean(team)} · for ${clean(view.seat)}: ${n(view.claimable)} claimable, ${n(view.blocked)} blocked`,
  ];
  if (view.carrying.length > 0) out.push(`${view.seat} is carrying ${view.carrying.join(', ')}`);
  const section = (gs: PickerGroup[], blocked: boolean) => {
    for (const g of gs) {
      out.push('', `${clean(g.goal ?? 'no goal')}:`);
      for (const r of g.rows) {
        const areas = r.areas.length ? ` [${clean(r.areas.join(','))}]` : '';
        out.push(`  ${r.id}  ${age(r.age_ms).padStart(4)}  ${clean(r.title)}${areas}`);
        if (r.declined)
          out.push(`      declined by ${clean(r.declined.by)}: ${clean(r.declined.reason)}`);
        if (blocked)
          for (const b of r.blocked_on)
            out.push(`      blocked on ${b.lane.slice(0, 10)} (owner ${b.owner ?? 'unowned'})`);
      }
    }
  };
  section(view.claimable, false);
  if (view.blocked.length > 0) {
    out.push('', 'blocked:');
    section(view.blocked, true);
  }
  return out;
}

export const NARROW_HINT = `widen the terminal to ${MIN_COLS} columns for the picker`;

/**
 * What a terminal too narrow for the picker prints (design §6: below about 60 columns, the plain
 * table with a hint). `narrow` adds the hint, as `musterd pick` does on a TTY under `MIN_COLS`.
 */
export function pickTableLines(view: PickerView, team: string, narrow: boolean): string[] {
  const table = renderPickTable(view, team);
  return narrow ? [...table, '', NARROW_HINT] : table;
}
