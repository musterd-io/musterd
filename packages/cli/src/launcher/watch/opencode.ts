import {
  opencodeDbPath,
  opencodeReadSql,
  runSqlite,
  type RunSqlite,
} from '../../trace/opencode.js';
import type { LocalWake } from '../live.js';
import { textEvent, toolEvent, type WatchEvent } from './events.js';
import type { WatchReader } from './reader.js';

/** Messages one read takes. A longer session catches up over several polls. */
const READ_MESSAGES = 400;

/** Which tool inputs say what a call is about, in the order they are tried. */
const ARG_KEYS = [
  'command',
  'filePath',
  'file_path',
  'path',
  'pattern',
  'query',
  'url',
  'name',
  'id',
] as const;

/** One row of the read: a message and one of its parts (`pd` null for a message with no parts). */
export interface Row {
  mid: string;
  mt: number;
  md: string;
  pd: string | null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Obj) : undefined;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const json = (s: string | null): Obj | undefined => {
  if (!s) return undefined;
  try {
    return obj(JSON.parse(s));
  } catch {
    return undefined;
  }
};

/**
 * What an opencode wake said and did, from the rows of its completed assistant messages: each
 * message's `text` parts (its words) and `tool` parts (the tool's name and the one input that says
 * what it is about). Never a tool part's `state.output` or `metadata` — that is the result — and
 * never reasoning, step bookkeeping or patches. `finish` is the LAST message's finish reason.
 */
export function watchRows(rows: readonly Row[]): { events: WatchEvent[]; finish: string | null } {
  const byMessage = new Map<string, { md: string; parts: Obj[] }>();
  for (const r of rows) {
    let m = byMessage.get(r.mid);
    if (!m) byMessage.set(r.mid, (m = { md: r.md, parts: [] }));
    const part = json(r.pd);
    if (part) m.parts.push(part);
  }
  const events: WatchEvent[] = [];
  let finish: string | null = null;
  for (const { md, parts } of byMessage.values()) {
    const message = json(md);
    if (!message) continue;
    finish = str(message['finish']) || null;
    const completed = obj(message['time'])?.['completed'];
    for (const p of parts) {
      const start = obj(p['time'])?.['start'];
      const ts =
        typeof start === 'number' ? start : typeof completed === 'number' ? completed : null;
      if (p['type'] === 'text') {
        const e = textEvent(ts, str(p['text']));
        if (e) events.push(e);
      } else if (p['type'] === 'tool') {
        const input = obj(obj(p['state'])?.['input']) ?? {};
        const key = ARG_KEYS.find((k) => typeof input[k] === 'string' && input[k] !== '');
        events.push(toolEvent(ts, str(p['tool']) || 'tool', key ? str(input[key]) : ''));
      }
    }
  }
  return { events, finish };
}

export interface OpencodeReaderDeps {
  run?: RunSqlite;
  dbPath?: string;
}

/**
 * opencode: its SQLite store (`$XDG_DATA_HOME/opencode/opencode.db`), read through the `sqlite3` CLI
 * as the trace tail already does — no new dependency. The reader keeps a cursor and what it has
 * parsed, so each poll asks only for messages newer than the last. A machine without `sqlite3`, or a
 * store it cannot read, answers null on the first poll ("no transcript") and keeps the last good
 * answer afterwards. The session id goes into SQL, so only opencode's own id alphabet is accepted.
 */
export function opencodeReader(deps: OpencodeReaderDeps = {}): WatchReader {
  let after = 0;
  const events: WatchEvent[] = [];
  let finish: string | null = null;
  let read = false;
  return {
    async snapshot(wake: LocalWake) {
      const id = wake.session_id;
      if (!id || !/^[\w-]+$/.test(id)) return null;
      const raw = await (deps.run ?? runSqlite)(
        deps.dbPath ?? opencodeDbPath(),
        opencodeReadSql(id, after, READ_MESSAGES),
      );
      if (raw !== null) {
        let rows: Row[] | undefined;
        try {
          rows = raw.trim() ? (JSON.parse(raw) as Row[]) : [];
        } catch {
          rows = undefined;
        }
        if (rows) {
          read = true;
          if (rows.length > 0) {
            const next = watchRows(rows);
            events.push(...next.events);
            finish = next.finish ?? finish;
            after = Math.max(after, ...rows.map((r) => r.mt));
          }
        }
      }
      return read ? { events: [...events], endedCleanly: finish === 'stop' } : null;
    },
  };
}
