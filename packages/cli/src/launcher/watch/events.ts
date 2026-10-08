import { scrubCredentials } from '@musterd/protocol';

/** One thing a wake did, as `watch` shows it (ADR 546). */
export interface WatchEvent {
  ts: number | null;
  kind: 'text' | 'tool';
  line: string;
}

/** Which tool arguments say what a call is about, in the order they are tried. */
const ARG_KEYS = ['command', 'file_path', 'path', 'id', 'lane_id', 'pattern'] as const;

interface Record_ {
  type?: unknown;
  timestamp?: unknown;
  message?: { stop_reason?: unknown; content?: unknown };
}

function parse(line: string): Record_ | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? (v as Record_) : null;
  } catch {
    return null; // a half-written last line, or noise: skipped, never fatal
  }
}

/**
 * Whitespace collapsed to single spaces, and every other control character (C0, DEL, C1 — ESC
 * included) dropped: a wake's words and tool arguments are untrusted text headed for a terminal,
 * and an escape sequence in them could rewrite the screen or set the title.
 */
/* eslint-disable no-control-regex */
const oneLine = (s: string): string =>
  s
    .replace(/\s+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim();
/* eslint-enable no-control-regex */

/**
 * What a wake said and did, read from its Claude Code transcript lines: its words and its tool
 * calls. Never tool RESULTS — they hold file contents and command output the person did not ask to
 * see, and watch is a window onto the wake's work, not a copy of its inputs. Every line goes through
 * the same credential scrub as captured traces, since a wake's words can quote a key it just read.
 */
export function watchEvents(lines: readonly string[]): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (const raw of lines) {
    const rec = parse(raw);
    if (rec?.type !== 'assistant') continue;
    const content = rec.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    const stamp = Number.isNaN(ts) ? null : ts;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block['type'] === 'text' && typeof block['text'] === 'string') {
        const text = oneLine(block['text']);
        if (text) out.push({ ts: stamp, kind: 'text', line: `“${scrubCredentials(text).text}”` });
      } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const name = block['name'].replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
        const input = (block['input'] ?? {}) as Record<string, unknown>;
        const key = ARG_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '');
        const arg = key ? oneLine(String(input[key])) : '';
        const line = `▸ ${name}${arg ? `  ${arg}` : ''}`;
        out.push({ ts: stamp, kind: 'tool', line: scrubCredentials(line).text });
      }
    }
  }
  return out;
}

/**
 * True when the last assistant record stopped because the model was done (`end_turn`). A wake that
 * ends any other way — a tool call in flight, a refusal, a cut-off — ended early. The launcher is
 * not the wake's parent, so it cannot read an exit code; the transcript is the only witness.
 */
export function endedCleanly(lines: readonly string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = parse(lines[i]!);
    if (rec?.type === 'assistant') return rec.message?.stop_reason === 'end_turn';
  }
  return false;
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
