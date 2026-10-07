import { theme } from '../../render/theme.js';
import { padEndVisible, visibleLen } from '../../render/ui.js';
import { harnessLabel, LAUNCHABLE_HARNESSES } from '../labels.js';
import {
  ago,
  canVerb,
  describeLive,
  describeMove,
  describeWhere,
  liveQuestion,
  seatLine,
} from '../rows.js';
import { lastUsedAt } from '../store.js';
import { entryFor, rows, selectable, shownHarness, type PickerState, type Row } from './state.js';

export interface PickerSize {
  cols: number;
  rows: number;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*m/g;

/** The picker screen as lines (spec §3): header, list, footer. Pure — tty.ts writes it. */
export function renderPicker(s: PickerState, size: PickerSize): string[] {
  const out: string[] = [header(s, size.cols), ''];
  if (s.query) out.push(`  ${theme.meta('search ›')} ${s.query}▏`);
  const list = s.help ? helpLines().map((line) => ({ line, selected: false })) : body(s, size.cols);
  const foot = footer(s, size.cols);
  const room = Math.max(1, size.rows - out.length - 1 - foot.length);
  out.push(...window(list, room), '', ...foot);
  return out.map((l) => clip(l, size.cols));
}

function header(s: PickerState, cols: number): string {
  const crumbs =
    s.level.kind === 'teams'
      ? ['teams']
      : s.level.kind === 'projects'
        ? [s.level.team]
        : s.level.kind === 'members'
          ? [s.level.team, s.level.project]
          : [];
  const left = `${theme.presenceDot('online')} ${theme.presenceDot('away')} ${theme.presenceDot('offline')} ${['musterd', ...crumbs].join(' › ')}`;
  const teams = [...new Set(s.seats.map((x) => x.team))].sort().join(', ');
  const status =
    s.liveStatus === 'pending'
      ? ' · checking…'
      : s.liveStatus === 'offline'
        ? ' · offline · live state unavailable'
        : '';
  const right = theme.meta(`${teams ? `${teams} · ` : ''}${s.seats.length} seats here${status}`);
  const gap = Math.max(1, cols - visibleLen(left) - visibleLen(right));
  return left + ' '.repeat(gap) + right;
}

function body(s: PickerState, cols: number): { line: string; selected: boolean }[] {
  const all = rows(s);
  if (all.length === 0) {
    return [
      {
        line: s.scanning
          ? '  finding seats…'
          : '  no seats on this machine yet — run `musterd init` in a project checkout',
        selected: false,
      },
    ];
  }
  const seatRows = all.filter((r): r is Extract<Row, { kind: 'seat' }> => r.kind === 'seat');
  const memberRows = all.filter((r): r is Extract<Row, { kind: 'member' }> => r.kind === 'member');
  const nameWidth = Math.max(
    8,
    ...seatRows.map((r) => r.seat.member.length + 2),
    ...memberRows.map((r) => r.entry.member.length + 2),
  );
  const showAddress = cols >= 70 && seatRows.some((r) => r.showAddress);
  const addressWidth = showAddress
    ? Math.max(...seatRows.map((r) => `${r.seat.team}/${r.seat.project}`.length)) + 2
    : null;
  const sel = all.filter(selectable)[s.cursor];
  return all.map((row) => {
    const selected = row === sel;
    const marker = selected ? `${theme.accent('›')} ` : '  ';
    switch (row.kind) {
      case 'heading':
        return { line: `  ${theme.meta(row.label)}`, selected };
      case 'hint':
        return { line: `  ${theme.meta(row.text)}`, selected };
      case 'member': {
        const verb = canVerb(row.entry.can);
        return {
          line: `${marker}${padEndVisible(theme.memberName(row.entry.member, row.entry.kind), nameWidth)}${theme.meta(describeWhere(row.entry))}${verb ? `  ${theme.meta(verb)}` : ''}`,
          selected,
        };
      }
      case 'new-seat':
        return { line: `${marker}${theme.accent('+ new seat')}`, selected };
      case 'team':
        return {
          line: `${marker}${padEndVisible(row.team, 9)}${row.here ? `${theme.ok('●')} here  ${row.count} seats` : theme.meta('○ no Workspace here')}${row.star ? '  ★' : ''}`,
          selected,
        };
      case 'project':
        return {
          line: `${marker}${padEndVisible(row.project, 9)}${theme.ok('●')} here  ${row.count} seats${row.star ? '  ★' : ''}${row.remote ? `  ${theme.meta(row.remote)}` : ''}`,
          selected,
        };
      case 'seat': {
        const { seat } = row;
        const live = s.live[seat.address];
        const used = lastUsedAt(seat, s.file);
        let tail = live
          ? describeLive(live, s.now)
          : seat.problem
            ? theme.warn('needs repair')
            : used !== null
              ? `${seat.address === s.file.last ? '★ last used · ' : ''}${ago(used, s.now)}`
              : '';
        // ADR 503: a folder here whose seat lives elsewhere says so, with what ⏎ can do about it.
        const entry = entryFor(s, seat);
        if (entry && entry.can !== 'launch' && !live) {
          const verb = canVerb(entry.can);
          tail = `${tail ? `${tail} · ` : ''}${theme.meta(describeWhere(entry))}${verb ? `  ${theme.meta(verb)}` : ''}`;
        }
        const harness = seat.kind === 'human' ? 'human' : (shownHarness(s, seat) ?? 'claude-code');
        return {
          line: seatLine(seat, {
            selected,
            nameWidth,
            addressWidth: row.showAddress ? addressWidth : null,
            showHarness: cols >= 56,
            harness,
            state: live
              ? 'live'
              : s.liveStatus === 'offline' || s.unknownLive.includes(seat.address)
                ? 'unknown'
                : 'idle',
            tail,
          }),
          selected,
        };
      }
    }
  });
}

/** The `room` lines around the selected one, so the cursor never scrolls off screen. */
function window(items: { line: string; selected: boolean }[], room: number): string[] {
  const at = Math.max(
    0,
    items.findIndex((x) => x.selected),
  );
  const start = Math.min(Math.max(0, at - room + 1), Math.max(0, items.length - room));
  return items.slice(start, start + room).map((x) => x.line);
}

function footer(s: PickerState, cols: number): string[] {
  if (s.choose) {
    // The harness step: always shown for an agent seat, so a one-harness seat says it has one.
    const c = s.choose;
    const last = s.file.seats[c.seat.address]?.harness ?? null;
    const n = c.options.length;
    return [
      `  ${c.seat.member} · ${n} harness${n === 1 ? '' : 'es'} configured`,
      ...c.options.map((h, i) => {
        const marker = i === c.index ? `${theme.accent('›')} ` : '  ';
        const label =
          h === last
            ? `${padEndVisible(harnessLabel(h), 10)}${theme.meta('last used')}`
            : harnessLabel(h);
        return `  ${marker}${label}`;
      }),
      theme.meta('  ⏎ launch · ↑↓ choose · esc back'),
    ];
  }
  if (s.create) {
    const d = s.create;
    if (d.naming) {
      const prompt = `  new seat in ${d.team}/${d.project} › ${d.member}▏   ⏎ next · esc cancel`;
      return d.error ? [prompt, `  ${theme.warn(d.error)}`] : [prompt];
    }
    // Wrapped like the live-seat question: its keys must stay visible at any width.
    return wrap(
      `set up ${d.member} here → ~/musterd/${d.team}/${d.project}/${d.member} · ${harnessLabel(LAUNCHABLE_HARNESSES[d.harness]!)} (⇥ to change) · ⏎ set up and launch · esc cancel`,
      cols - 2,
    ).map((l) => `  ${l}`);
  }
  if (s.confirm) {
    const live = s.live[s.confirm.seat.address];
    const member = s.confirm.seat.member;
    // Wrapped, never clipped: a question whose `(y/N)` is cut off cannot be answered.
    return wrap(
      live
        ? liveQuestion(member, live, s.now)
        : `${member} is live elsewhere. Open a second session in the same folder? (y/N)`,
      cols - 2,
    ).map((l) => `  ${l}`);
  }
  if (s.help) return [theme.meta('  any key to go back')];
  if (s.query) return [theme.meta('  ⏎ launch · ⌃R resume · esc clear')];
  if (s.level.kind === 'recent') {
    // ADR 540: a team row on the first screen opens; a seat row launches.
    const onTeam = rows(s).filter(selectable)[s.cursor]?.kind === 'team';
    return [
      theme.meta(
        onTeam
          ? '  ⏎ open · type to search · → teams · esc quit'
          : '  ⏎ launch · ⌃R resume · type to search · → teams · esc quit',
      ),
    ];
  }
  if (s.level.kind === 'members') {
    const row = rows(s).filter(selectable)[s.cursor];
    const entry =
      row?.kind === 'member' ? row.entry : row?.kind === 'seat' ? entryFor(s, row.seat) : null;
    // The `none` row names where the seat is and the move ceremony (ADR 503 Decision 2).
    if (entry && entry.can === 'none' && (entry.where === 'node' || entry.where === 'cloud'))
      return wrap(describeMove(entry), cols - 2).map((l) => `  ${theme.meta(l)}`);
    if (row?.kind === 'member' && entry?.can === 'wake')
      return [theme.meta('  ⏎ wake — rings its doorbell (a steer, as you) · ← back · esc back')];
    if (row?.kind === 'member' && entry?.can === 'setup')
      return [theme.meta('  ⏎ set up here · ← back · esc back')];
    return [theme.meta('  ⏎ launch · ⌃R resume · ⇥ harness · ← back · esc back')];
  }
  return [theme.meta('  ⏎ open · ← back · type to search · esc back')];
}

/** Word-wrap plain text to `width` columns; a word longer than the width is left to `clip`. */
function wrap(text: string, width: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && [...line].length + 1 + [...word].length > width) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

function helpLines(): string[] {
  return [
    '  ↑ ↓ / ⌃P ⌃N   move',
    '  ⏎              launch fresh · open a team or project',
    '  ⌃R             resume the last session',
    '  ⇥              next harness, when the seat has several',
    '  → ←            into the teams, a team, a project · back out',
    '  letters        search every seat',
    '  esc            clear · back · quit',
    '  ⌃C             quit',
  ];
}

function clip(line: string, cols: number): string {
  if (visibleLen(line) <= cols) return line;
  const plain = line.replace(ANSI, '');
  return [...plain].slice(0, Math.max(0, cols - 1)).join('') + '…';
}
