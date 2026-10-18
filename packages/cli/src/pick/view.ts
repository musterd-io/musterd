import { filterPicker, type PickerRow } from '@musterd/protocol';
import type { PickerSize } from '../launcher/picker/view.js';
import { theme } from '../render/theme.js';
import { padEndVisible } from '../render/ui.js';
import { visibleRows, type PickState } from './state.js';
import { age, clean, cut, wrap } from './text.js';

/** Below this the screen is not drawn; the command prints the plain table instead. */
export const MIN_COLS = 60;
/** At or above this the brief sits beside the list; below it, under the list. */
export const SIDE_BY_SIDE_COLS = 100;

/**
 * The lane picker screen (spec §5.2): header, the list grouped by goal, the highlighted lane's
 * brief, a key footer. Pure — `runScreen` writes it. Every lane string passes through `clean`.
 */
export function renderLanePicker(s: PickState, size: PickerSize): string[] {
  const { cols, rows } = size;
  if (cols < MIN_COLS) return [theme.meta(`widen the terminal to ${MIN_COLS} columns · esc quits`)];
  const head = header(s, cols);
  const foot = [
    theme.meta(cut('type to filter · ↑↓ move · tab claimable/blocked · ⏎ pick · esc quit', cols)),
  ];
  const room = Math.max(4, rows - head.length - foot.length);
  const rowsShown = visibleRows(s);
  const sel = rowsShown[s.cursor];
  let bodyLines: string[];
  if (cols >= SIDE_BY_SIDE_COLS) {
    const left = Math.max(36, Math.floor(cols * 0.45));
    const right = cols - left - 3;
    const list = listLines(s, left, room);
    const brief = briefLines(sel, right, s.now).slice(0, room);
    bodyLines = Array.from({ length: room }, (_, i) =>
      `${padEndVisible(list[i] ?? '', left)} ${theme.meta('│')} ${brief[i] ?? ''}`.trimEnd(),
    );
  } else {
    const listRoom = Math.max(3, Math.floor(room / 2));
    const list = listLines(s, cols, listRoom);
    const brief = briefLines(sel, cols, s.now).slice(0, room - listRoom - 1);
    bodyLines = [...padTo(list, listRoom), theme.meta('─'.repeat(cols)), ...brief];
  }
  // Every field is cut to its column before painting, so no line is sliced here: slicing a painted
  // line would cut an escape sequence in half.
  return [...head, ...bodyLines, ...foot];
}

function header(s: PickState, cols: number): string[] {
  const filtered = filterPicker(s.view, s.filter);
  const n = (k: 'claimable' | 'blocked') => filtered[k].reduce((a, g) => a + g.rows.length, 0);
  const tabs =
    (s.tab === 'claimable' ? theme.accent : theme.meta)(`${n('claimable')} claimable`) +
    theme.meta(' · ') +
    (s.tab === 'blocked' ? theme.accent : theme.meta)(`${n('blocked')} blocked`);
  const title = `${theme.bold('musterd pick')} ${theme.meta('—')} ${clean(s.team)} ${theme.meta('· for')} ${clean(s.seat)}`;
  const lines = [`${title}   ${tabs}`];
  if (s.view.carrying.length > 0)
    lines.push(theme.warn(cut(`${s.seat} is carrying ${s.view.carrying.join(', ')}`, cols)));
  lines.push(
    s.notice
      ? theme.warn(cut(clean(s.notice), cols))
      : `${theme.meta('filter ›')} ${clean(s.filter)}▏`,
  );
  return lines;
}

function listLines(s: PickState, width: number, room: number): string[] {
  const groups = filterPicker(s.view, s.filter)[s.tab];
  if (groups.length === 0)
    return [theme.meta(s.filter ? 'nothing matches the filter' : `no ${s.tab} lanes`)];
  const out: { line: string; selected: boolean }[] = [];
  let i = 0;
  for (const g of groups) {
    out.push({ line: theme.meta(cut(clean(g.goal ?? 'no goal'), width)), selected: false });
    for (const r of g.rows) {
      const selected = i === s.cursor;
      const label = cut(`${r.short} ${clean(r.title)}`, width - 2);
      out.push({ line: selected ? theme.accent(`▸ ${label}`) : `  ${label}`, selected });
      i++;
    }
  }
  // Keep the selected row on screen: scroll the window so it sits inside it.
  const at = Math.max(
    0,
    out.findIndex((o) => o.selected),
  );
  const start = Math.min(Math.max(0, at - Math.floor(room / 2)), Math.max(0, out.length - room));
  return out.slice(start, start + room).map((o) => o.line);
}

function briefLines(r: PickerRow | undefined, width: number, now: number): string[] {
  if (!r) return [];
  const opened = new Date(now - r.age_ms).toISOString().slice(0, 10);
  const meta = [
    `goal ${clean(r.goal_id ?? '—')}`,
    r.areas.length ? `areas ${clean(r.areas.join(', '))}` : null,
    `opened ${opened} (${age(r.age_ms)} ago)`,
  ]
    .filter(Boolean)
    .join(' · ');
  const out = [
    theme.bold(r.short),
    ...wrap(r.title, width).map((l) => theme.bold(l)),
    '',
    ...wrap(meta, width).map((l) => theme.meta(l)),
  ];
  if (r.risk.length > 0)
    out.push(
      ...wrap(`risk ${r.risk.join(', ')} — acceptance goes to a human`, width).map((l) =>
        theme.warn(l),
      ),
    );
  if (r.scope.length > 0)
    out.push(...wrap(`scope ${r.scope.join(', ')}`, width).map((l) => theme.meta(l)));
  if (r.declined)
    out.push(
      ...wrap(`declined by ${r.declined.by}: ${r.declined.reason}`, width).map((l) =>
        theme.warn(l),
      ),
    );
  for (const b of r.blocked_on)
    out.push(...wrap(`blocked: ${b.detail}`, width).map((l) => theme.warn(l)));
  if (r.detail) out.push('', ...wrap(r.detail, width));
  return out;
}

function padTo(lines: string[], n: number): string[] {
  return [...lines, ...Array.from({ length: Math.max(0, n - lines.length) }, () => '')].slice(0, n);
}
