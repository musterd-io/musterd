import { readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { LocalWake } from '../live.js';
import { pickArg, textEvent, toolEvent, type WatchEvent } from './events.js';
import { readCompleteLines } from './lines.js';
import type { WatchReader } from './reader.js';

interface Rec {
  timestamp?: unknown;
  type?: unknown;
  payload?: { type?: unknown; item?: Record<string, unknown> } & Record<string, unknown>;
}

function parse(line: string): Rec | null {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === 'object' && v !== null ? (v as Rec) : null;
  } catch {
    return null; // a half-written last line, or noise: skipped, never fatal
  }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The shell command of a `CommandExecution`: codex wraps it as `[shell, -lc, "<command>"]`. */
function commandOf(command: unknown): string {
  if (!Array.isArray(command)) return '';
  const parts = command.filter((p): p is string => typeof p === 'string');
  return parts.length >= 3 && /^-\w*c\w*$/.test(parts[1]!) ? parts[2]! : parts.join(' ');
}

/**
 * What a Codex wake said and did, from its rollout (`~/.codex/sessions/Y/M/D/rollout-*-<thread>.jsonl`).
 * Read from the COMPLETED items codex records as `event_msg.item_completed`: its words
 * (`AgentMessage`) and the tools it ran (`CommandExecution`, `McpToolCall`, `FileChange`). Never an
 * item's output or an MCP `result` — those hold file contents and tool output. Reasoning, user
 * turns, usage and bookkeeping are not shown.
 */
export function watchEvents(lines: readonly string[]): WatchEvent[] {
  const out: WatchEvent[] = [];
  for (const raw of lines) {
    const rec = parse(raw);
    if (rec?.type !== 'event_msg' || rec.payload?.type !== 'item_completed') continue;
    const item = rec.payload.item;
    if (!item) continue;
    const ms = typeof rec.timestamp === 'string' ? Date.parse(rec.timestamp) : NaN;
    const ts = Number.isNaN(ms) ? null : ms;
    switch (item['type']) {
      case 'AgentMessage': {
        const content = Array.isArray(item['content']) ? item['content'] : [];
        const words = content
          .map((c) =>
            typeof c === 'object' && c !== null ? str((c as Record<string, unknown>)['text']) : '',
          )
          .join(' ');
        const e = textEvent(ts, words);
        if (e) out.push(e);
        break;
      }
      case 'CommandExecution':
        out.push(toolEvent(ts, 'Bash', commandOf(item['command'])));
        break;
      case 'McpToolCall': {
        out.push(toolEvent(ts, str(item['tool']) || 'mcp', pickArg(item['arguments'])));
        break;
      }
      case 'FileChange': {
        const changes = item['changes'];
        const first =
          typeof changes === 'object' && changes !== null ? Object.keys(changes)[0] : undefined;
        out.push(toolEvent(ts, 'apply_patch', first ?? ''));
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/**
 * True when the last turn boundary in the rollout is `task_complete`. A `task_started` after it,
 * a `turn_aborted`, or no boundary at all means the run did not finish its work.
 */
export function endedCleanly(lines: readonly string[]): boolean {
  for (let i = lines.length - 1; i >= 0; i--) {
    const rec = parse(lines[i]!);
    if (rec?.type !== 'event_msg') continue;
    const t = rec.payload?.type;
    if (t === 'task_complete') return true;
    if (t === 'task_started' || t === 'turn_aborted') return false;
  }
  return false;
}

/**
 * The rollout for a thread id: newest date folder first, the file whose name ends `-<id>.jsonl`.
 * The id becomes part of a name match, never a path, and anything outside codex's id alphabet is
 * refused. Undefined when there is no such file (yet).
 */
export function codexRolloutPath(threadId: string, home = homedir()): string | undefined {
  if (!/^[\w-]+$/.test(threadId)) return undefined;
  const root = join(home, '.codex', 'sessions');
  const list = (dir: string): string[] => {
    try {
      return readdirSync(dir).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of list(root))
    for (const m of list(join(root, y)))
      for (const d of list(join(root, y, m))) {
        const hit = list(join(root, y, m, d)).find(
          (f) => f.startsWith('rollout-') && f.endsWith(`-${threadId}.jsonl`),
        );
        if (hit) return join(root, y, m, d, hit);
      }
  return undefined;
}

export interface CodexReaderDeps {
  rolloutPath?: (threadId: string) => string | undefined;
  readLines?: (path: string) => string[];
}

/** Codex: the lease's `session_id` is the thread id; the rollout is found once and then re-read. */
export function codexReader(deps: CodexReaderDeps = {}): WatchReader {
  let found: string | undefined;
  return {
    snapshot(wake: LocalWake) {
      if (!wake.session_id) return null;
      found ??= (deps.rolloutPath ?? codexRolloutPath)(wake.session_id);
      if (!found) return null;
      let lines: string[];
      try {
        lines = (deps.readLines ?? readCompleteLines)(found);
      } catch {
        lines = [];
      }
      return { events: watchEvents(lines), endedCleanly: endedCleanly(lines) };
    },
  };
}
