import { HUDDLE_TRACE_MAX_EVENTS, type HuddleTrace, type HuddleTraceSeat } from '@musterd/protocol';
import { theme } from './theme.js';

/**
 * `musterd huddle show <id> --trace` (ADR 493): the room as one timeline — a seat table (how each
 * seat came in, its wake, how long it took to speak) over every event, clock first. The daemon
 * did the join; this only draws it. Frame: docs/design/figma-brief-terminal.md §huddle trace.
 */

type KindOf = (name: string) => 'agent' | 'human';

function hms(ts: number): string {
  const d = new Date(ts);
  return [d.getHours(), d.getMinutes(), d.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join(':');
}

function span(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function wakeCell(s: HuddleTraceSeat): string {
  const w = s.wake;
  if (!w) return '—';
  const head = w.outcome === 'woke' ? (w.session ?? 'woke') : w.outcome;
  const parts = [head];
  if (w.duration_ms !== null) parts.push(secs(w.duration_ms));
  if (w.cost_usd !== null) parts.push(`$${w.cost_usd.toFixed(2)}`);
  return parts.join(' · ');
}

function turnCell(s: HuddleTraceSeat): string {
  if (s.time_to_turn_ms === null) return 'not yet';
  if (s.summoned === 'opener') return '—';
  return `+${(s.time_to_turn_ms / 60_000).toFixed(1)}m`;
}

/** Pad on the PLAIN width, then colour — padding a coloured string counts its escape codes. */
const cell = (plain: string, width: number, paint: (s: string) => string = (s) => s) =>
  paint(plain) + ' '.repeat(Math.max(1, width - plain.length));

/** Clip one event line's text to what is left of the terminal after the clock, seat and kind columns. */
function clip(text: string, width: number): string {
  return text.length > width ? `${text.slice(0, Math.max(1, width - 1))}…` : text;
}

export function renderHuddleTrace(
  t: HuddleTrace,
  kindOf: KindOf,
  /** Terminal width; the label column takes what the fixed columns leave. */
  columns = 100,
): string {
  const labelWidth = Math.max(30, columns - 29);
  const out: string[] = [];
  const h = t.huddle;
  const state = h.closed ? theme.meta('closed') : theme.ok('open');
  out.push(
    `${theme.accent(`huddle trace ${h.topic}`)} ${state} ${theme.meta(`· ${h.id.slice(0, 10)} · ${t.seats.length} seats`)}`,
  );
  out.push(
    theme.meta(
      `  opened by ${h.opener} ${hms(h.opened_at)}` +
        (h.closed
          ? ` · closed ${hms(h.closed.at)} (${span(h.closed.at - h.opened_at)})`
          : ' · open'),
    ),
  );
  out.push('');

  const seats = [...t.seats].sort(
    (a, b) => (a.time_to_turn_ms ?? Infinity) - (b.time_to_turn_ms ?? Infinity),
  );
  out.push(
    theme.meta(
      `  ${cell('seat', 10)}${cell('in as', 9)}${cell('wake', 27)}${cell('harness', 13)}to turn`,
    ),
  );
  for (const s of seats) {
    out.push(
      `  ${cell(s.seat, 10, (n) => theme.memberName(n, kindOf(n)))}${cell(s.summoned, 9)}` +
        `${cell(wakeCell(s), 27)}${cell(s.harness ?? '—', 13, theme.meta)}${turnCell(s)}`,
    );
  }
  out.push('');

  for (const e of t.events) {
    let text = clip(e.label, labelWidth);
    if (e.kind === 'tool' && e.outcome)
      text += `  ${e.outcome === 'ok' ? theme.ok(e.outcome) : theme.err(e.outcome)}`;
    if ((e.kind === 'tool' || e.kind === 'hook') && e.duration_ms !== undefined)
      text += ` ${secs(e.duration_ms)}`;
    const paintKind = e.kind === 'act' ? theme.bold : e.kind === 'hook' ? theme.warn : theme.meta;
    out.push(
      `  ${theme.meta(hms(e.ts))}  ${cell(e.seat, 10, (n) => theme.memberName(n, kindOf(n)))}${cell(e.kind, 7, paintKind)}${e.kind === 'hook' ? theme.warn(text) : text}`,
    );
  }
  if (t.truncated) {
    out.push('');
    out.push(theme.warn(`  timeline cut at ${HUDDLE_TRACE_MAX_EVENTS} events`));
  }
  return out.join('\n');
}
