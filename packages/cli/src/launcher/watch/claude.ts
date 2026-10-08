import { claudeTranscriptPath } from '../../host/backends/claudeCode.js';
import type { LocalWake } from '../live.js';
import { textEvent, toolEvent, type WatchEvent } from './events.js';
import { readCompleteLines } from './lines.js';
import type { WatchReader } from './reader.js';

/** Which tool arguments say what a call is about, in the order they are tried. */
const ARG_KEYS = ['command', 'file_path', 'path', 'id', 'lane_id', 'pattern'] as const;

interface Rec {
  type?: unknown;
  timestamp?: unknown;
  message?: { stop_reason?: unknown; content?: unknown };
}

function parse(line: string): Rec | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? (v as Rec) : null;
  } catch {
    return null; // a half-written last line, or noise: skipped, never fatal
  }
}

/**
 * What a wake said and did, from its Claude Code transcript lines: its words and its tool calls.
 * Never tool RESULTS — they hold file contents and command output the person did not ask to see.
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
        const e = textEvent(stamp, block['text']);
        if (e) out.push(e);
      } else if (block['type'] === 'tool_use' && typeof block['name'] === 'string') {
        const name = block['name'].replace(/^mcp__[^_]+(?:_[^_]+)*__/, '');
        const input = (block['input'] ?? {}) as Record<string, unknown>;
        const key = ARG_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '');
        out.push(toolEvent(stamp, name, key ? String(input[key]) : ''));
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

export interface ClaudeReaderDeps {
  transcriptPath?: (sessionId: string) => string | undefined;
  /** Complete lines of a file (see `readCompleteLines`). */
  readLines?: (path: string) => string[];
}

/** Claude Code: `~/.claude/projects/<slug>/<session id>.jsonl`, found by the lease's session id. */
export function claudeReader(deps: ClaudeReaderDeps = {}): WatchReader {
  return {
    snapshot(wake: LocalWake) {
      if (!wake.session_id) return null;
      const path = (deps.transcriptPath ?? claudeTranscriptPath)(wake.session_id);
      if (!path) return null;
      const read = deps.readLines ?? readCompleteLines;
      let lines: string[];
      try {
        lines = read(path);
      } catch {
        lines = [];
      }
      return { events: watchEvents(lines), endedCleanly: endedCleanly(lines) };
    },
  };
}
