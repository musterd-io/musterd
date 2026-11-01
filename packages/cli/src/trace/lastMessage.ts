import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { opencodeDbPath, runSqlite, type RunSqlite } from './opencode.js';

/**
 * The turn's last assistant message, for the inferred-question catcher (ADR 785) on harnesses whose
 * turn-end hook does not carry it (Claude Code's `last_assistant_message` does). Each reads the
 * harness's own session store, which already holds the message when the hook runs:
 *
 * - Grok: `updates.jsonl`, the `agent_message_chunk` updates after the turn's last tool call
 *   (written before the `stop` hook runs, grok 1.0.70, 2026-11-01).
 * - Muse: `session.jsonl`, the `assistant_message_committed` run event (committed before
 *   `hook_run_started` for Stop, Muse 1.4.14, 2026-11-01).
 * - OpenCode: `opencode.db`, the session's last assistant message when it finished on `stop`.
 *
 * Undefined whenever the turn did not end on prose: a tool call after the text, a new prompt, or
 * nothing readable. Never throws.
 */

/** How much of a session log's end is read. A final message is far smaller; a log can be huge. */
export const LAST_MESSAGE_TAIL_BYTES = 512 * 1024;

/** The log's last `max` bytes as lines, newest last. A first line cut mid-way is dropped. */
export function readTailLines(path: string, max = LAST_MESSAGE_TAIL_BYTES): string[] {
  let fd: number | undefined;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - max);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf8').split('\n');
    if (start > 0) lines.shift();
    return lines;
  } catch {
    return [];
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

function parse(line: string): Record<string, unknown> | undefined {
  if (!line.trim()) return undefined;
  try {
    return obj(JSON.parse(line));
  } catch {
    return undefined;
  }
}

const nonBlank = (s: string): string | undefined => (s.trim() ? s : undefined);

/** Updates that sit between a turn's last text and its Stop without ending the text. */
const GROK_PASS = new Set(['hook_execution', 'hook_annotation', 'agent_thought_chunk']);

/** Grok: the trailing run of `agent_message_chunk` text in `updates.jsonl`. */
export function lastGrokMessage(updatesPath: string): string | undefined {
  const lines = readTailLines(updatesPath);
  const chunks: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const update = obj(obj(parse(lines[i]!)?.['params'])?.['update']);
    if (!update) continue;
    const kind = update['sessionUpdate'];
    if (kind === 'agent_message_chunk') {
      const text = obj(update['content'])?.['text'];
      if (typeof text === 'string') chunks.unshift(text);
      continue;
    }
    if (typeof kind === 'string' && GROK_PASS.has(kind)) continue;
    break; // a tool call, a prompt, the previous turn's end: the text before it is not this turn's
  }
  return nonBlank(chunks.join(''));
}

/** Muse: the last `assistant_message_committed`, unless a tool call or a prompt came after it. */
export function lastMuseMessage(logPath: string): string | undefined {
  const lines = readTailLines(logPath);
  for (let i = lines.length - 1; i >= 0; i--) {
    const o = parse(lines[i]!);
    if (!o) continue;
    if (o['payload_type'] === 'runtime.user_intent.accepted') return undefined;
    const event = obj(obj(o['payload'])?.['event']);
    const kind = event?.['kind'];
    if (kind === 'assistant_tool_calls_committed') return undefined;
    if (kind === 'assistant_message_committed') {
      const text = event?.['text'];
      return typeof text === 'string' ? nonBlank(text) : undefined;
    }
  }
  return undefined;
}

/**
 * OpenCode v2 (`session_message`, measured on 2.2.2): the message rows carry their parts inline as
 * `data.content`. v1 (`message` + `part`, what the R2 tail reads) is the fallback for older builds.
 */
export function opencodeLastMessageSql(sessionId: string): { v2: string; v1: string } {
  const sid = sessionId.replace(/'/g, "''");
  return {
    v2: `SELECT data FROM session_message
 WHERE session_id = '${sid}' AND type = 'assistant'
 ORDER BY seq DESC LIMIT 1;`,
    v1: `SELECT m.data AS md, p.data AS pd FROM message m LEFT JOIN part p ON p.message_id = m.id
 WHERE m.id = (SELECT id FROM message WHERE session_id = '${sid}'
   AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC, id DESC LIMIT 1)
 ORDER BY p.id;`,
  };
}

/**
 * The text of a finished message's parts; undefined when it called a tool, or names a finish other
 * than `stop` (v2 always names one; a v1 row may not, and its parts are then the evidence).
 */
function finishedText(message: Record<string, unknown>, parts: unknown[]): string | undefined {
  if (message['finish'] !== undefined && message['finish'] !== 'stop') return undefined;
  const texts: string[] = [];
  for (const p of parts) {
    const part = obj(p);
    if (part?.['type'] === 'tool') return undefined;
    if (part?.['type'] === 'text' && typeof part['text'] === 'string') texts.push(part['text']);
  }
  return nonBlank(texts.join('\n\n'));
}

function rows(out: string | null): Record<string, unknown>[] {
  if (!out?.trim()) return [];
  try {
    const v: unknown = JSON.parse(out);
    return Array.isArray(v) ? (v.map(obj).filter(Boolean) as Record<string, unknown>[]) : [];
  } catch {
    return [];
  }
}

const parseData = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'string' ? parse(v) : undefined;

export async function lastOpencodeMessage(
  sessionId: string,
  opts: { dbPath?: string; run?: RunSqlite } = {},
): Promise<string | undefined> {
  try {
    const db = opts.dbPath ?? opencodeDbPath();
    const run = opts.run ?? runSqlite;
    const sql = opencodeLastMessageSql(sessionId);
    const v2 = await run(db, sql.v2);
    if (v2 !== null) {
      const message = parseData(rows(v2)[0]?.['data']);
      const content = message?.['content'];
      return message && Array.isArray(content) ? finishedText(message, content) : undefined;
    }
    const v1 = rows(await run(db, sql.v1));
    const message = parseData(v1[0]?.['md']);
    if (!message) return undefined;
    return finishedText(message, v1.map((r) => parseData(r['pd'])).filter(Boolean));
  } catch {
    return undefined;
  }
}
