import { scrubCredentials } from '@musterd/protocol';

declare const madeByConstructor: unique symbol;

/**
 * One thing a wake did, as `watch` shows it (ADR 546). Branded: the only way to hold one is
 * {@link textEvent} / {@link toolEvent}, so a reader that builds an object literal does not
 * typecheck — what watch may show cannot be skipped by writing the shape by hand.
 */
export interface WatchEvent {
  readonly [madeByConstructor]: true;
  readonly ts: number | null;
  readonly kind: 'text' | 'tool';
  readonly line: string;
}

/**
 * Whitespace collapsed to single spaces, and every other control character (C0, DEL, C1 — ESC
 * included) dropped: a wake's words and tool arguments are untrusted text headed for a terminal,
 * and an escape sequence in them could rewrite the screen or set the title.
 */
/* eslint-disable no-control-regex */
export const oneLine = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
/* eslint-enable no-control-regex */

/**
 * The ONLY way a reader makes an event. What watch is allowed to show lives here, once, so a new
 * harness's reader cannot forget it: words and tool calls only (a reader has no way to hand over a
 * tool RESULT), every line through the credential scrub, and no control characters. A harness reader
 * parses its own transcript format and stops at these two constructors.
 */
export function textEvent(ts: number | null, words: string): WatchEvent | null {
  const text = oneLine(words);
  return text
    ? ({ ts, kind: 'text', line: `“${scrubCredentials(text).text}”` } as WatchEvent)
    : null;
}

/** A tool call: its name and the one argument that says what it is about (`arg` may be empty). */
export function toolEvent(ts: number | null, name: string, arg: string): WatchEvent {
  const shown = oneLine(arg);
  const line = `▸ ${oneLine(name)}${shown ? `  ${shown}` : ''}`;
  return { ts, kind: 'tool', line: scrubCredentials(line).text } as WatchEvent;
}

const clock = (ts: number): string => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/** One row for the terminal: `HH:MM  ` (when known) then the line, cut to `cols` with `…`. */
export function formatWatchLine(e: WatchEvent, cols: number): string {
  const full = `${e.ts !== null ? `${clock(e.ts)}  ` : ''}${e.line}`;
  const chars = [...full];
  return chars.length <= cols ? full : `${chars.slice(0, Math.max(1, cols - 1)).join('')}…`;
}

/** Which tool arguments say what a call is about, in the order they are tried. */
const ARG_KEYS = ['id', 'lane_id', 'to', 'act', 'title', 'body', 'path', 'query'] as const;

/** The one argument of an MCP tool call worth showing, or '' — never the whole input. */
export function pickArg(args: unknown): string {
  if (typeof args !== 'object' || args === null) return '';
  const a = args as Record<string, unknown>;
  const key = ARG_KEYS.find((k) => typeof a[k] === 'string' && a[k] !== '');
  return key ? (a[key] as string) : '';
}
