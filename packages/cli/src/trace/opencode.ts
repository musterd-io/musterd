import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { type Binding, type TraceEvent } from '@musterd/protocol';
import { sessionDigest } from '../session/digest.js';
import { emitTraceEvents, traceClient, traceTapEnabled, writeTraceContentMode } from './hook.js';
import { postTailRecords, readTailCursor, writeTailCursor } from './tail.js';
import { type TranscriptRecord } from './transcript.js';

/**
 * Rail R2 for OpenCode (ADR 445, lane 01M3MGQ6M1). OpenCode keeps no transcript file: its sessions
 * live in a SQLite store (`opencode.db`: `message` rows, and `part` rows for each message's text,
 * reasoning, tool calls and step markers). The file tail's byte-offset cursor has no meaning there,
 * so this reads by MESSAGE instead: completed assistant messages created after the cursor, oldest
 * first, and the cursor is the last one's `time_created`.
 *
 * One completed assistant message is one model call, so it is one `usage` record: its tokens are
 * the message's own `tokens`, and its `tool_uses` counts the message's `tool` parts. That count is
 * the denominator of the coverage ratio. Reasoning and text parts are `reasoning` / `assistant_text`
 * records. Every record of a message joins its first tool call's id, as Claude's do.
 *
 * The store is read through the `sqlite3` CLI, as `observeModel` already reads it (no new
 * dependency). A machine without `sqlite3` records no R2 for OpenCode — fail-open, like every tap.
 */

export const OPENCODE_TRANSCRIPT_PARSER = 'opencode@1';

/** Messages one read will take. A session that predates the tap catches up over several idles. */
export const OPENCODE_READ_MESSAGES = 400;

/** Where OpenCode keeps its store: `$XDG_DATA_HOME/opencode/opencode.db`, else under `~/.local/share`. */
export function opencodeDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_DATA_HOME'] || join(homedir(), '.local', 'share');
  return join(base, 'opencode', 'opencode.db');
}

/** One row of the read: a message and one of its parts (`pd` null for a message with no parts). */
export interface OpencodeRow {
  mid: string;
  mt: number;
  md: string;
  pd: string | null;
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : undefined;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

function parseJson(s: string | null): Record<string, unknown> | undefined {
  if (!s) return undefined;
  try {
    return obj(JSON.parse(s));
  } catch {
    return undefined;
  }
}

/**
 * Turn the read's rows into R2 records, message by message, in row order. A message whose JSON does
 * not parse is one `unknown` record, never dropped; a part type this parser does not know is
 * counted onto the message's usage as `unknown_parts` rather than emitted per part.
 */
export function parseOpencodeRows(rows: readonly OpencodeRow[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const byMessage = new Map<string, { md: string; parts: Record<string, unknown>[] }>();
  for (const r of rows) {
    let m = byMessage.get(r.mid);
    if (!m) {
      m = { md: r.md, parts: [] };
      byMessage.set(r.mid, m);
    }
    const part = parseJson(r.pd);
    if (part) m.parts.push(part);
  }
  for (const { md, parts } of byMessage.values()) {
    const message = parseJson(md);
    if (!message) {
      out.push({
        kind: 'unknown',
        detail: { parser: OPENCODE_TRANSCRIPT_PARSER, bytes: bytes(md), parse_error: true },
      });
      continue;
    }
    const time = obj(message['time']);
    const completed = num(time?.['completed']);
    const join = parts
      .filter((p) => p['type'] === 'tool')
      .map((p) => str(p['callID']))
      .find(Boolean);
    let toolUses = 0;
    let unknownParts = 0;
    for (const p of parts) {
      const type = str(p['type']);
      if (type === 'tool') {
        toolUses++;
        continue;
      }
      if (type === 'reasoning' || type === 'text') {
        const kind = type === 'reasoning' ? 'reasoning' : 'assistant_text';
        const text = str(p['text']) ?? '';
        const ts = num(obj(p['time'])?.['start']) ?? completed;
        out.push({
          kind,
          ...(ts !== undefined ? { ts } : {}),
          ...(join ? { tool_use_id: join } : {}),
          detail: {
            parser: OPENCODE_TRANSCRIPT_PARSER,
            [kind === 'reasoning' ? 'reasoning_bytes' : 'assistant_bytes']: bytes(text),
            ...(kind === 'reasoning' &&
            str(obj(obj(p['metadata'])?.['openai'])?.['reasoningEncryptedContent'])
              ? { encrypted: true }
              : {}),
          },
          ...(text ? { text } : {}),
        });
        continue;
      }
      // step-start / step-finish repeat the message's own bookkeeping; patch is a file snapshot.
      if (type === 'step-start' || type === 'step-finish' || type === 'patch') continue;
      unknownParts++;
    }
    const tokens = obj(message['tokens']) ?? {};
    const cache = obj(tokens['cache']) ?? {};
    const counters: Record<string, number> = {};
    const put = (ours: string, v: unknown): void => {
      const n = num(v);
      if (n !== undefined) counters[ours] = n;
    };
    put('input_tokens', tokens['input']);
    put('output_tokens', tokens['output']);
    put('reasoning_tokens', tokens['reasoning']);
    put('cache_read_tokens', cache['read']);
    put('cache_creation_tokens', cache['write']);
    put('total_tokens', tokens['total']);
    const model = str(message['modelID']);
    out.push({
      kind: 'usage',
      ...(completed !== undefined ? { ts: completed } : {}),
      ...(join ? { tool_use_id: join } : {}),
      detail: {
        parser: OPENCODE_TRANSCRIPT_PARSER,
        ...(model ? { model: model.slice(0, 128) } : {}),
        ...counters,
        tool_uses: toolUses,
        ...(unknownParts > 0 ? { unknown_parts: unknownParts } : {}),
      },
    });
  }
  return out;
}

/** The read: completed assistant messages of one session after `after`, with their parts. */
export function opencodeReadSql(sessionId: string, after: number, limit: number): string {
  const sid = sessionId.replace(/'/g, "''");
  return `SELECT m.id AS mid, m.time_created AS mt, m.data AS md, p.data AS pd
  FROM message m LEFT JOIN part p ON p.message_id = m.id
 WHERE m.id IN (
   SELECT id FROM message
    WHERE session_id = '${sid}' AND time_created > ${String(Math.floor(after))}
      AND json_extract(data, '$.role') = 'assistant'
      AND json_extract(data, '$.time.completed') IS NOT NULL
    ORDER BY time_created, id LIMIT ${String(limit)})
 ORDER BY m.time_created, m.id, p.id;`;
}

export type RunSqlite = (db: string, sql: string) => Promise<string | null>;

export const runSqlite: RunSqlite = (db, sql) =>
  new Promise((resolve) => {
    try {
      execFile(
        'sqlite3',
        ['-readonly', '-json', db, sql],
        { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 * 1024 },
        (err, stdout) => resolve(err ? null : String(stdout)),
      );
    } catch {
      resolve(null);
    }
  });

/**
 * The one-call form OpenCode's idle hook uses: cursor → read → parse → post → advance. Never
 * throws; returns whether anything landed (for a caller's counter, never control flow).
 */
export async function tailOpencodeSession(opts: {
  binding: Binding | null;
  dir: string;
  sessionId: string;
  env?: NodeJS.ProcessEnv;
  dbPath?: string;
  run?: RunSqlite;
}): Promise<boolean> {
  try {
    if (!traceTapEnabled(opts.env)) return false;
    const binding = opts.binding;
    if (!binding?.agent_key) return false;
    // The id is interpolated into SQL: refuse anything but OpenCode's own id alphabet.
    if (!/^[\w-]+$/.test(opts.sessionId)) return false;
    const db = opts.dbPath ?? opencodeDbPath(opts.env);
    const digest = sessionDigest(binding.agent_key, opts.sessionId);
    const cursor = readTailCursor(opts.dir, digest);
    if (cursor?.downgraded) return false;
    const after = cursor && cursor.path === db ? cursor.offset : 0;

    const raw = await (opts.run ?? runSqlite)(
      db,
      opencodeReadSql(opts.sessionId, after, OPENCODE_READ_MESSAGES),
    );
    if (raw === null) return false;
    let rows: OpencodeRow[];
    try {
      rows = raw.trim() ? (JSON.parse(raw) as OpencodeRow[]) : [];
    } catch {
      return false;
    }
    if (rows.length === 0) return true;

    const http = traceClient(binding, opts.dir);
    if (!http) return false;
    const post = (events: readonly TraceEvent[]): Promise<boolean> =>
      emitTraceEvents(http, binding.team, events, undefined, (mode) =>
        writeTraceContentMode(opts.dir, mode),
      );
    const { allLanded, events } = await postTailRecords(parseOpencodeRows(rows), {
      binding,
      dir: opts.dir,
      harness: 'opencode',
      digest,
      post,
    });
    if (allLanded) {
      writeTailCursor(opts.dir, digest, {
        path: db,
        offset: Math.max(...rows.map((r) => r.mt)),
        updated_at: Date.now(),
      });
    }
    return allLanded && events > 0;
  } catch {
    return false;
  }
}
