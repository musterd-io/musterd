import { sinceLabel, theme } from '../render/theme.js';
import { hint, padEndVisible, sym } from '../render/ui.js';
import { harnessLabel } from './labels.js';
import type { Live, WakeFor } from './live.js';
import type { MemberEntry, Seat } from './store.js';

/*
 * Row and receipt rendering shared by the picker and `musterd seats` (ADR 491). On the paint path:
 * it loads only the theme, `ui` and labels; `Live` is a type import.
 */

/** `now`, `5m`, `2h`, `3d`. */
export function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86_400)}d`;
}

/** `9s`, `42m`, `2h 5m`. */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** The one line printed when the harness exits (spec §3.5). */
export function formatReceipt(
  member: string,
  harness: string,
  durationMs: number,
  code: number,
): string {
  const mark = code === 0 ? theme.ok(sym.ok) : theme.err(sym.err);
  return `${mark} ${member} · ${harnessLabel(harness)} · ${formatDuration(durationMs)} · exit ${code} ${theme.meta('· musterd - to go back')}`;
}

/** `here · since 15:37` / `on mini-2 · since 15:37`. */
export function describeLive(live: Live, now: number): string {
  const where = live.where === 'here' ? 'here' : `on ${live.label}`;
  return live.since !== null ? `${where} · since ${sinceLabel(live.since, now)}` : where;
}

/** `here (claude-code) since 15:37` — the live-seat prompt's wording. */
export function describeLiveLong(live: Live, now: number): string {
  const where = live.where === 'here' ? 'here' : `on ${live.label}`;
  return `${where} (${live.surface})${live.since !== null ? ` since ${sinceLabel(live.since, now)}` : ''}`;
}

export interface SeatLineOpts {
  selected: boolean;
  nameWidth: number;
  /** null → no `team/project` column. */
  addressWidth: number | null;
  showHarness: boolean;
  /** Harness id, or `human` for a human seat. */
  harness: string;
  state: 'live' | 'idle' | 'unknown';
  tail: string;
}

/** One seat row: marker · member · [team/project] · [harness] · state · tail. */
export function seatLine(seat: Seat, o: SeatLineOpts): string {
  const marker = o.selected ? `${theme.accent('›')} ` : '  ';
  const shown = theme.memberName(seat.member, seat.kind);
  const name = padEndVisible(o.selected ? theme.bold(shown) : shown, o.nameWidth);
  const address =
    o.addressWidth === null
      ? ''
      : padEndVisible(theme.meta(`${seat.team}/${seat.project}`), o.addressWidth);
  const harness = o.showHarness ? padEndVisible(theme.meta(harnessLabel(o.harness)), 9) : '';
  const state = padEndVisible(
    o.state === 'live'
      ? `${theme.ok('●')} live`
      : o.state === 'idle'
        ? `${theme.meta('○')} idle`
        : theme.meta('?'),
    8,
  );
  return `${marker}${name}${address}${harness}${state}${o.tail}`.trimEnd();
}

export interface SeatEntry {
  seat: Seat;
  live: Live | null;
  lastUsed: number | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/g;

/** A node label is a teammate-chosen string painted on this terminal: no control bytes reach it. */
export function plainLabel(label: string): string {
  return label.replace(CONTROL, '');
}

/** `on node-2` / `in the cloud` / `nowhere` — the row's `where` in words (ADR 503). */
export function describeWhere(m: Pick<MemberEntry, 'where' | 'where_label'>): string {
  const label = m.where_label === null ? null : plainLabel(m.where_label);
  switch (m.where) {
    case 'here':
      return 'here';
    case 'node':
      return `on ${label || m.where}`;
    case 'cloud':
      return label ? `cloud · ${label}` : 'cloud';
    case 'nowhere':
      return 'nowhere';
  }
}

/** `resident on air-2 — move it: musterd residency off + node unbind there` (the `none` row's line). */
export function describeMove(entry: Pick<MemberEntry, 'where' | 'where_label'>): string {
  const where =
    entry.where === 'cloud'
      ? 'in the cloud'
      : `on ${entry.where_label ? plainLabel(entry.where_label) : 'another machine'}`;
  return `resident ${where} — move it: musterd residency off + node unbind there`;
}

/** The dimmed verb beside a row (ADR 503 Decision 3): what `⏎` does, or nothing. */
export function canVerb(can: MemberEntry['can']): string {
  return can === 'setup' ? 'set up' : can === 'none' ? '' : can;
}

export interface SeatsListExtras {
  /** The roster-first rows (ADR 503): members with no Workspace here are listed under their team. */
  members?: readonly MemberEntry[];
  /** Teams whose roster did not answer — the receipt says the list is folder-only for them. */
  rosterMissing?: readonly string[];
}

/** `musterd seats` (spec §3.6): every seat, grouped by team/project; then each team's other members. */
export function renderSeatsList(
  entries: SeatEntry[],
  stale: number,
  now: number,
  extras: SeatsListExtras = {},
): string {
  const members = extras.members ?? [];
  if (entries.length === 0 && members.length === 0) {
    return `no seats on this machine yet\n${hint('musterd init in a project checkout, or musterd agent <name>')}`;
  }
  const nameWidth = Math.max(0, ...entries.map((e) => e.seat.member.length)) + 2;
  const out = [theme.bold(`seats on this machine · ${entries.length}`)];
  const groups = new Map<string, SeatEntry[]>();
  for (const e of entries) {
    const key = `${e.seat.team}/${e.seat.project}`;
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  for (const [key, group] of groups) {
    out.push('', theme.accent(key));
    for (const { seat, live, lastUsed } of group) {
      const tail = live
        ? describeLive(live, now)
        : seat.problem
          ? theme.warn('needs repair')
          : lastUsed !== null
            ? ago(lastUsed, now)
            : '';
      out.push(
        seatLine(seat, {
          selected: false,
          nameWidth,
          addressWidth: null,
          showHarness: true,
          harness:
            seat.kind === 'human'
              ? 'human'
              : (seat.harnesses.find((h) => h !== 'musterd') ??
                seat.last_session?.harness ??
                'claude-code'),
          state: live ? 'live' : 'idle',
          tail,
        }),
      );
    }
  }
  // ADR 503 Decision 1: the team is the unit. Members with no folder here are rows too, each with
  // where it lives and what this machine can do about it — never a silent `setup` of a seat that is
  // resident elsewhere.
  const away = members.filter((m) => m.address === null);
  const teams = [...new Set(away.map((m) => m.team))].sort();
  for (const team of teams) {
    const rows = away.filter((m) => m.team === team);
    const w = Math.max(...rows.map((m) => m.member.length)) + 2;
    out.push('', theme.accent(`${team} · on the team`));
    for (const m of rows) {
      const name = padEndVisible(theme.memberName(m.member, m.kind), w);
      const verb = canVerb(m.can);
      out.push(
        `  ${name}${theme.meta(describeWhere(m))}${verb ? `  ${theme.meta(verb)}` : ''}`.trimEnd(),
      );
    }
  }
  for (const team of extras.rosterMissing ?? [])
    out.push('', theme.meta(`${team}: roster unavailable — this machine's folders only`));
  if (stale > 0) out.push('', theme.meta(`${stale} stale · musterd init --prune-bindings --apply`));
  return out.join('\n');
}

/** An act kind as prose, with its article: `an ask`, `a handoff`, `a help request`. */
function actPhrase(act: string): string {
  const words = act === 'request_help' ? 'help request' : act.replace(/_/g, ' ');
  return `${/^[aeiou]/.test(words) ? 'an' : 'a'} ${words}`;
}

/**
 * Why a wake happened, as a clause that follows "musterd started it headless" (ADR 543) — empty
 * when the roster could not say. A lane is named by its 10-character prefix, as the board does.
 */
export function wakeReason(w: WakeFor | null | undefined): string {
  if (!w) return '';
  const lane = w.lane_id ? `lane ${w.lane_id.slice(0, 10)}` : null;
  const from = w.from ? ` from ${w.from}` : '';
  if (lane && w.edge === 'review') return ` to judge ${lane} for acceptance`;
  if (lane && w.edge === 'dispatch_continuation') return ` to carry on with ${lane}`;
  if (lane && w.edge === 'dispatch_handoff') return ` for ${lane}, handed over${from}`;
  if (lane) return ` for ${lane}`;
  if (w.act) return ` to answer ${actPhrase(w.act)}${from}`;
  return '';
}

/**
 * The live-seat question, shared by \`musterd <seat>\` and the picker (ADR 491 Decision 6). A wake
 * says so and why, says it is expected, and says what a second session does to it (ADR 543): a
 * same-folder successor replaces it once it has held for the ADR 092 grace.
 */
export function liveQuestion(member: string, live: Live, now: number): string {
  const where = describeLiveLong(live, now);
  if (live.wake === undefined)
    return `${member} is live ${where}. Open a second session in the same folder? (y/N)`;
  return (
    `${member} is live ${where} — a wake: musterd started it headless${wakeReason(live.wake)}. ` +
    `That's expected; it exits when the work is done. ` +
    `A second session replaces it within seconds and cuts that work off. Open one anyway? (y/N)`
  );
}

/** The one-line form for a refusal without a TTY: where it is live, and whether it is a wake. */
export function liveSummary(live: Live, now: number): string {
  const where = describeLiveLong(live, now);
  return live.wake === undefined ? where : `${where} — a wake${wakeReason(live.wake)}`;
}

/**
 * The take over / watch menu for a live local wake (ADR 546), one string per line. The same words
 * `musterd <seat>` and the picker print; the terminal frame in figma-brief-terminal.md copies them.
 */
export function wakeMenu(member: string, live: Live, now: number): string[] {
  const since = live.since !== null ? ` started ${sinceLabel(live.since, now)}` : '';
  return [
    `${member} is busy — a wake${since}${wakeReason(live.wake)}.`,
    '  ⏎  take over   stop the wake, continue its conversation here',
    '  w  watch       follow it live; ⏎ takes over at any point',
    '  esc cancel',
  ];
}
