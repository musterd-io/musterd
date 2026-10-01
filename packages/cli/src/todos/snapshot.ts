import { closeSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type Binding, bindingSeat, type Lane, LANE_TERMINAL_STATES } from '@musterd/protocol';
import type { HttpClient } from '../client.js';
import { traceClient } from '../trace/hook.js';
import { EMPTY_TODO_STATE, foldTodos, type TodoState, unfinishedTodos } from './parse.js';

/**
 * The unfinished-to-do snapshot (ADR 487 §5.2): at a turn boundary, what the session's to-do tool
 * says is still open goes onto the seat's most recently updated live lane, last write wins.
 *
 * **No new hook.** It rides the processes that already read the transcript at a turn boundary —
 * Claude Code's `Stop` trace tap and Codex's per-call hook (`trace/tail.ts` names both) — so a turn
 * spawns exactly what it spawned before (ADR 445 §Consequences).
 *
 * **Cheap when unused**, which on this team is always (0 to-do tool calls in 14 days, 2026-09-30):
 * the delta is read from an offset cursor in `.musterd/todos.json`, a delta naming none of the tools
 * is skipped unparsed, and the daemon is called only when the unfinished list CHANGED.
 *
 * **No seat-memory fallback.** The spec sends a lane-less seat's to-dos to seat memory; seat memory
 * is one hand-written note, last write wins, and a turn-end hook overwriting it every turn would
 * destroy exactly the continuity it exists for. A seat with no live lane gets no snapshot
 * (ADR 487 Consequences, 2026-09-30).
 *
 * Fail-open and bounded like the trace tap: a miss is a stale snapshot, never a failed hook.
 */

export const TODOS_STATE_FILE = 'todos.json';
/** A turn's delta beyond this is skipped to its end rather than read: a hook has a budget. */
const MAX_DELTA_BYTES = 8 * 1024 * 1024;
const POST_BUDGET_MS = 1_500;

interface Cursor {
  path: string;
  offset: number;
  state: TodoState;
  /** The list last written to the daemon, as JSON — the change detector. */
  sent: string | null;
}

const HARNESSES = new Set(['claude-code', 'codex']);

function readCursor(dir: string): Cursor | null {
  try {
    const o = JSON.parse(readFileSync(join(dir, '.musterd', TODOS_STATE_FILE), 'utf8')) as Cursor;
    return typeof o.path === 'string' && typeof o.offset === 'number' ? o : null;
  } catch {
    return null;
  }
}

function writeCursor(dir: string, c: Cursor): void {
  try {
    writeFileSync(join(dir, '.musterd', TODOS_STATE_FILE), JSON.stringify(c));
  } catch {
    /* a lost cursor re-reads the transcript next turn; nothing else depends on it */
  }
}

/** The complete lines appended since `offset`, and the offset just past them. */
export function readDelta(path: string, offset: number): { text: string; end: number } | null {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return null;
  }
  const from = size < offset ? 0 : offset;
  if (size - from > MAX_DELTA_BYTES) return { text: '', end: size };
  if (size === from) return { text: '', end: from };
  const buf = Buffer.alloc(size - from);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buf, 0, buf.length, from);
  } finally {
    closeSync(fd);
  }
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return { text: '', end: from };
  return { text: buf.subarray(0, lastNl + 1).toString('utf8'), end: from + lastNl + 1 };
}

/** The seat's most recently updated live lane — the snapshot is advisory, not an assignment. */
export function targetLane(lanes: readonly Lane[], seat: string): Lane | null {
  const live = lanes.filter(
    (l) => l.owner_seat === seat && !LANE_TERMINAL_STATES.has(l.state) && l.state !== 'parked',
  );
  return live.reduce<Lane | null>((a, l) => (a && a.updated_at >= l.updated_at ? a : l), null);
}

async function withinBudget<T>(p: Promise<T>): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race<T | undefined>([
      p.catch(() => undefined),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), POST_BUDGET_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function snapshotTodos(opts: {
  binding: Binding | null | undefined;
  dir: string;
  harness: string;
  transcriptPath: string;
  http?: HttpClient | null;
}): Promise<void> {
  try {
    if (!opts.binding || !HARNESSES.has(opts.harness)) return;
    const prior = readCursor(opts.dir);
    const cursor: Cursor =
      prior && prior.path === opts.transcriptPath
        ? prior
        : {
            path: opts.transcriptPath,
            offset: 0,
            state: EMPTY_TODO_STATE,
            sent: prior?.sent ?? null,
          };
    const delta = readDelta(opts.transcriptPath, cursor.offset);
    if (!delta) return;
    cursor.state = foldTodos(cursor.state, opts.harness, delta.text);
    cursor.offset = delta.end;
    const items = unfinishedTodos(cursor.state);
    const json = JSON.stringify(items);
    // Unchanged, or nothing was ever sent and nothing is open: no daemon call at all.
    if (json === cursor.sent || (cursor.sent === null && items.length === 0)) {
      writeCursor(opts.dir, cursor);
      return;
    }
    const seat = bindingSeat(opts.binding);
    const http = opts.http !== undefined ? opts.http : traceClient(opts.binding, opts.dir);
    if (!seat || !http) return writeCursor(opts.dir, cursor);
    const board = await withinBudget(http.laneBoard(opts.binding.team, { mine: true }));
    const lane = board ? targetLane(board.lanes, seat) : null;
    if (lane) {
      const landed = await withinBudget(
        http.updateLane(opts.binding.team, lane.id, { unfinished_todos: items }),
      );
      if (landed) cursor.sent = json;
    }
    writeCursor(opts.dir, cursor);
  } catch {
    /* fail-open by contract */
  }
}
