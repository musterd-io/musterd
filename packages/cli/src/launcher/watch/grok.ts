import { transcriptPathFor } from '../../trace/tail.js';
import type { LocalWake } from '../live.js';
import { textEvent, toolEvent, type WatchEvent } from './events.js';
import { readCompleteLines } from './lines.js';
import type { WatchReader } from './reader.js';

/** Which tool arguments say what a call is about, in the order they are tried. */
const ARG_KEYS = [
  'command',
  'target_file',
  'path',
  'file_path',
  'pattern',
  'query',
  'url',
] as const;

/** Updates that neither end a run of message text nor are shown: bookkeeping and tool results. */
const QUIET_UPDATES = new Set(['hook_execution', 'tool_call_update', 'retry_state']);

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Each parseable line's update, with the time it carries. Unparseable lines are skipped. */
function updates(
  lines: readonly string[],
): Array<{ type: string; update: Obj; ts: number | null }> {
  const out: Array<{ type: string; update: Obj; ts: number | null }> = [];
  for (const line of lines) {
    let o: Obj | undefined;
    try {
      o = obj(JSON.parse(line));
    } catch {
      continue; // a half-written last line, or noise
    }
    const params = obj(o?.['params']);
    const update = obj(params?.['update']);
    const type = str(update?.['sessionUpdate']);
    if (!update || !type) continue;
    const agentMs = obj(params?.['_meta'])?.['agentTimestampMs'];
    const secs = o?.['timestamp'];
    const ts =
      typeof agentMs === 'number' ? agentMs : typeof secs === 'number' ? secs * 1000 : null;
    out.push({ type, update, ts });
  }
  return out;
}

/**
 * What a Grok wake said and did, from its `updates.jsonl`: its message text (streamed as chunks,
 * joined into one message per run) and the tool calls it made (`tool_call`: the tool's name and the
 * one argument that says what it is about). Never a `tool_call_update` — those carry the results —
 * and never thoughts, hooks or the user's turn. A message still being streamed is held back until
 * something follows it, so a poll never prints half a sentence and then the whole one.
 */
export function watchEvents(lines: readonly string[]): WatchEvent[] {
  const out: WatchEvent[] = [];
  let words = '';
  let wordsTs: number | null = null;
  const flush = (): void => {
    const e = textEvent(wordsTs, words);
    if (e) out.push(e);
    words = '';
    wordsTs = null;
  };
  for (const { type, update, ts } of updates(lines)) {
    if (QUIET_UPDATES.has(type)) continue;
    if (type === 'agent_message_chunk') {
      if (!words) wordsTs = ts;
      words += str(obj(update['content'])?.['text']);
      continue;
    }
    flush();
    if (type === 'tool_call') {
      const input = obj(update['rawInput']) ?? {};
      const key = ARG_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '');
      out.push(toolEvent(ts, str(update['title']) || 'tool', key ? str(input[key]) : ''));
    }
  }
  return out;
}

/** True when the last update that is not bookkeeping or a tool result is a `turn_completed`. */
export function endedCleanly(lines: readonly string[]): boolean {
  const all = updates(lines).filter((u) => !QUIET_UPDATES.has(u.type));
  return all.at(-1)?.type === 'turn_completed';
}

export interface GrokReaderDeps {
  transcriptPath?: (sessionId: string, workspace: string) => string | undefined;
  readLines?: (path: string) => string[];
}

/** Grok: `$GROK_HOME/sessions/<encoded cwd>/<session id>/updates.jsonl`, by the lease's session id. */
export function grokReader(deps: GrokReaderDeps = {}): WatchReader {
  return {
    snapshot(wake: LocalWake) {
      if (!wake.session_id) return null;
      const path = (
        deps.transcriptPath ??
        ((id, cwd) => transcriptPathFor({ harness: 'grok', session_id: id, cwd }))
      )(wake.session_id, wake.workspace);
      if (!path) return null;
      let lines: string[];
      try {
        lines = (deps.readLines ?? readCompleteLines)(path);
      } catch {
        lines = [];
      }
      return { events: watchEvents(lines), endedCleanly: endedCleanly(lines) };
    },
  };
}
