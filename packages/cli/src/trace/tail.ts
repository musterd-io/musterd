import {
  closeSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type Binding,
  scrubCredentials,
  TRACE_CONTENT_MAX_BYTES,
  TRACE_MAX_BATCH,
  TRACE_TAIL_FILE,
  type TraceEvent,
  TraceEventSchema,
} from '@musterd/protocol';
import { grokSessionsDirFor } from '../host/backends/grokUsage.js';
import { sessionDigest } from '../session/digest.js';
import {
  emitTraceEvents,
  traceClient,
  traceContentEnabled,
  traceTapEnabled,
  writeTraceContentMode,
} from './hook.js';
import {
  CLAUDE_TRANSCRIPT_PARSER,
  CODEX_TRANSCRIPT_PARSER,
  CURSOR_TRANSCRIPT_PARSER,
  GROK_TRANSCRIPT_PARSER,
  type TranscriptRecord,
  transcriptParserFor,
} from './transcript.js';

/**
 * Rail R2, the transcript tail (ADR 445 §2, increment 2). The host tails
 * `binding.session.transcript_path` and posts `reasoning` / `assistant_text` / `usage` events keyed
 * to the same session digest as rail R1.
 *
 * **Who runs it: the hook processes that already exist.** There is no long-lived tailer. The Claude
 * Code `Stop` hook (end of every turn), the `SessionEnd` capture, and the Codex `post-tool-use` /
 * `end` hooks each read the transcript's DELTA since the last read — an offset cursor per session in
 * `.musterd/trace-tail.json` — parse it, and post. A turn's reasoning therefore lands one turn late
 * at worst, and a dead session's remainder lands at SessionEnd.
 *
 * **Fail-open, like the rest of the tap.** Every miss is a dropped delta, never a failed hook. The
 * offset advances only when every posted chunk landed, so a missed post is retried on the next hook
 * (at the price of possible duplicates when a reply was lost after the daemon stored the rows —
 * research substrate accepts that trade; rows carry `seq` and `received_at` to see it).
 *
 * **A parse failure downgrades the session** (ADR 445 §2): the cursor is marked and the tail posts
 * one `unknown` event with `detail.downgraded`, which the daemon turns into a `trace.downgraded`
 * audit row. From then on the session is structural-only — R1 keeps recording; R2 stops reading.
 */

/** Per-session read state. `path` pins the cursor to one transcript file: a session that moves
 *  files re-reads from zero rather than misapply an offset. */
export interface TailCursor {
  path: string;
  offset: number;
  updated_at: number;
  /** Set on a parse failure or a truncated file — the session is structural-only from then on. */
  downgraded?: boolean;
}

interface TailFile {
  sessions: Record<string, TailCursor>;
}

/** How many session cursors the file keeps — oldest pruned first. A workspace has a handful of
 *  live sessions at most; the bound exists so the file cannot grow with history. */
export const TAIL_SESSION_CAP = 16;

/** The most transcript one hook process will read. A Stop-hook delta is one turn (KiB to a few
 *  hundred KiB); this bound is for the catch-up read of a session that predates the tail. What lies
 *  past it is read by the following hooks, `offset` advancing each time. */
export const TAIL_MAX_DELTA_BYTES = 16 * 1024 * 1024;

/** A tail's post budget. Not the per-tool-call `TRACE_POST_BUDGET_MS`: the tail runs at turn
 *  or session end, and a post that lands after the budget reads as failed — the cursor holds and the
 *  next hook re-posts the whole delta (codex 0cd68449, 2026-09-28: one 256-event chunk stored 8×). */
export const TAIL_POST_BUDGET_MS = 10_000;

/** `.musterd/<this>` — held (O_EXCL) while a hook tails, so two hooks firing together (codex
 *  post-tool-use + end, a Cursor IDE's doubled SessionEnd) cannot both read one cursor and post the
 *  same delta. A hook that finds it held skips: the holder posts the delta, the next hook catches up. */
export const TAIL_LOCK_FILE = 'trace-tail.lock';

/** A lock older than this was left by a hook that died holding it, and is broken. Far longer than
 *  a catch-up read posting chunk after chunk takes, so a live holder is not broken in practice. */
export const TAIL_LOCK_STALE_MS = 5 * 60_000;

function acquireTailLock(dir: string): (() => void) | null {
  const path = join(dir, '.musterd', TAIL_LOCK_FILE);
  const take = (): boolean => {
    try {
      closeSync(openSync(path, 'wx'));
      return true;
    } catch {
      return false;
    }
  };
  if (!take()) {
    try {
      if (Date.now() - statSync(path).mtimeMs <= TAIL_LOCK_STALE_MS) return null;
      rmSync(path, { force: true });
    } catch {
      return null;
    }
    if (!take()) return null;
  }
  return () => rmSync(path, { force: true });
}

export function readTailCursor(dir: string, digest: string): TailCursor | undefined {
  return readTailFile(dir).sessions[digest];
}

function readTailFile(dir: string): TailFile {
  try {
    const json: unknown = JSON.parse(readFileSync(join(dir, '.musterd', TRACE_TAIL_FILE), 'utf8'));
    const sessions = (json as TailFile).sessions;
    if (typeof sessions === 'object' && sessions !== null) return { sessions };
  } catch {
    /* absent or unreadable — start fresh */
  }
  return { sessions: {} };
}

export function writeTailCursor(dir: string, digest: string, cursor: TailCursor): void {
  try {
    const file = readTailFile(dir);
    file.sessions[digest] = cursor;
    const entries = Object.entries(file.sessions).sort((a, b) => b[1].updated_at - a[1].updated_at);
    file.sessions = Object.fromEntries(entries.slice(0, TAIL_SESSION_CAP));
    writeFileSync(join(dir, '.musterd', TRACE_TAIL_FILE), JSON.stringify(file) + '\n');
  } catch {
    /* a missing .musterd/ is an unbound folder — nothing to remember */
  }
}

/**
 * Read the transcript's unread suffix: whole lines only (a partial trailing line — the harness
 * mid-append — stays unread and unadvanced), at most {@link TAIL_MAX_DELTA_BYTES}. Returns the
 * lines and the offset they end at, or null when the file cannot be read (transient; not a
 * downgrade — the next hook retries).
 */
export function readTranscriptDelta(
  path: string,
  offset: number,
): { lines: string[]; nextOffset: number } | null {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    if (size <= offset) return { lines: [], nextOffset: offset };
    const want = Math.min(size - offset, TAIL_MAX_DELTA_BYTES);
    fd = openSync(path, 'r');
    const buf = Buffer.alloc(want);
    const got = readSync(fd, buf, 0, want, offset);
    const chunk = buf.subarray(0, got);
    // Advance only past the last complete line. UTF-8 safe: 0x0a never occurs inside a multi-byte
    // sequence, so slicing at it cannot split a character across reads.
    const lastNewline = chunk.lastIndexOf(0x0a);
    if (lastNewline < 0) return { lines: [], nextOffset: offset };
    const complete = chunk.subarray(0, lastNewline + 1);
    return {
      lines: complete.toString('utf8').split('\n').filter(Boolean),
      nextOffset: offset + lastNewline + 1,
    };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
    }
  }
}

/** Cut a string to at most `max` UTF-8 bytes without leaving half a character behind. */
function cutBytes(s: string, max: number): string {
  return Buffer.from(s, 'utf8').subarray(0, max).toString('utf8').replace(/�+$/, '');
}

/**
 * Build the wire event for one parsed record. Content (scrubbed, then bounded — the hook.ts order,
 * so a credential cannot survive by being split at the bound) only when the caller passed the
 * gates; `unknown` and `usage` records have no text so never a content part.
 */
export function buildTailEvent(
  record: TranscriptRecord,
  opts: { harness: string; digest: string; content: boolean; agentId?: string; now?: number },
): TraceEvent | null {
  const field = record.kind === 'reasoning' ? 'reasoning' : 'assistant';
  let content: TraceEvent['content'];
  if (
    opts.content &&
    record.text &&
    (record.kind === 'reasoning' || record.kind === 'assistant_text')
  ) {
    const scrubbed = scrubCredentials(record.text);
    let kept = scrubbed.text;
    let truncated = false;
    if (Buffer.byteLength(kept, 'utf8') > TRACE_CONTENT_MAX_BYTES) {
      kept = cutBytes(kept, TRACE_CONTENT_MAX_BYTES);
      truncated = true;
    }
    content = { [field]: kept, redactions: scrubbed.redactions, truncated };
  }
  const candidate = {
    harness: opts.harness,
    session_digest: opts.digest,
    ts: record.ts ?? opts.now ?? Date.now(),
    kind: record.kind,
    ...(record.tool_use_id ? { tool_use_id: record.tool_use_id.slice(0, 128) } : {}),
    ...(opts.agentId ? { agent_id: opts.agentId.slice(0, 128) } : {}),
    detail: record.detail,
    ...(content ? { content } : {}),
  };
  const ok = TraceEventSchema.safeParse(candidate);
  if (ok.success) return ok.data;
  // A content part the schema refuses must not cost the structural row it rode on.
  if (candidate.content === undefined) return null;
  const { content: _dropped, ...structural } = candidate;
  const retry = TraceEventSchema.safeParse(structural);
  return retry.success ? retry.data : null;
}

/** The downgrade marker event — the daemon writes the `trace.downgraded` audit row when it sees
 *  `detail.downgraded` (ADR 445 §2: "a parse failure downgrades the session … with an audit row"). */
function downgradeEvent(
  harness: string,
  digest: string,
  parser: string,
  reason: string,
  agentId?: string,
): TraceEvent | null {
  const candidate = {
    harness,
    session_digest: digest,
    ts: Date.now(),
    kind: 'unknown' as const,
    outcome: 'error' as const,
    ...(agentId ? { agent_id: agentId.slice(0, 128) } : {}),
    detail: { parser, downgraded: true, reason: reason.slice(0, 64) },
  };
  const ok = TraceEventSchema.safeParse(candidate);
  return ok.success ? ok.data : null;
}

/**
 * The transcript a harness's SessionEnd hook points the tail at. Claude Code and Cursor name it in
 * the payload (`transcript_path`); Grok does not, but files each session under
 * `$GROK_HOME/sessions/<encodeURIComponent(cwd)>/<sessionId>/`, and its `updates.jsonl` is the
 * rail R2 source (see `parseGrokTranscript`). Undefined when neither route names a file.
 */
export function transcriptPathFor(
  payload: { harness?: string; session_id?: string; transcript_path?: string; cwd?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (payload.transcript_path) return payload.transcript_path;
  if (payload.harness !== 'grok' || !payload.session_id || !payload.cwd) return undefined;
  // A session id is a path segment here: refuse anything that could walk out of the group.
  if (!/^[\w-]+$/.test(payload.session_id)) return undefined;
  const home = env['GROK_HOME'] ?? join(homedir(), '.grok');
  return join(grokSessionsDirFor(home, payload.cwd), payload.session_id, 'updates.jsonl');
}

/**
 * The sidechain transcript a `SubagentStop` hook points the tail at (lane 01M4VTRMXYZ). Uses
 * `agent_transcript_path` / `subagent_transcript_path` when the payload names one; otherwise
 * derives `<parent transcript stem>/subagents/agent-<agent_id>.jsonl` from `transcript_path` +
 * `agent_id` (`subagent_id`), which is where Claude Code writes a subagent's jsonl. Returns
 * undefined when `agent_id` is missing or not a plain token (`[\w-]+`).
 */
export function subagentTranscriptPathFor(payload: {
  agent_id?: string;
  subagent_id?: string;
  agent_transcript_path?: string;
  subagent_transcript_path?: string;
  transcript_path?: string;
}): { agentId: string; transcriptPath: string } | undefined {
  const agentId = payload.agent_id || payload.subagent_id;
  if (!agentId || !/^[\w-]+$/.test(agentId)) return undefined;
  const explicit = payload.agent_transcript_path || payload.subagent_transcript_path;
  if (explicit) return { agentId, transcriptPath: explicit };
  const parent = payload.transcript_path;
  if (!parent || !parent.endsWith('.jsonl')) return undefined;
  const stem = parent.slice(0, -'.jsonl'.length);
  return { agentId, transcriptPath: join(stem, 'subagents', `agent-${agentId}.jsonl`) };
}

/**
 * The one-call form the hook sites use: cursor → delta → parse → build → post → advance. Never
 * throws; never reads past the byte bound; returns whether anything landed (for a caller's counter,
 * never control flow).
 *
 * When `agentId` is passed (a `SubagentStop` sidechain read), events still carry the parent
 * session's `session_digest` and `agent_id = agentId`, while the cursor is keyed by
 * `${digest}:${agentId}` so the sidechain's offset never collides with the parent transcript's.
 */
export async function tailTranscript(opts: {
  binding: Binding | null;
  dir: string;
  harness: string;
  sessionId: string;
  transcriptPath: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  try {
    if (!traceTapEnabled(opts.env)) return false;
    const binding = opts.binding;
    if (!binding?.agent_key) return false;
    const parse = transcriptParserFor(opts.harness);
    if (!parse) return false;
    const digest = sessionDigest(binding.agent_key, opts.sessionId);
    const release = acquireTailLock(opts.dir);
    if (!release) return false;
    try {
      return await tailLocked(opts, binding, parse, digest);
    } finally {
      release();
    }
  } catch {
    return false;
  }
}

async function tailLocked(
  opts: { dir: string; harness: string; transcriptPath: string; agentId?: string },
  binding: Binding,
  parse: (lines: readonly string[]) => TranscriptRecord[],
  digest: string,
): Promise<boolean> {
  const cursorKey = opts.agentId ? `${digest}:${opts.agentId}` : digest;
  const cursor = readTailCursor(opts.dir, cursorKey);
  if (cursor?.downgraded) return false;
  const offset = cursor && cursor.path === opts.transcriptPath ? cursor.offset : 0;

  const http = traceClient(binding, opts.dir);
  if (!http) return false;
  const post = (events: readonly TraceEvent[]): Promise<boolean> =>
    emitTraceEvents(http, binding.team, events, TAIL_POST_BUDGET_MS, (mode) =>
      writeTraceContentMode(opts.dir, mode),
    );

  // A file shorter than the cursor is not append-only any more — the parser's ground assumption
  // is gone, so the session downgrades rather than guess at what a re-read would duplicate.
  let size: number;
  try {
    size = statSync(opts.transcriptPath).size;
  } catch {
    return false; // transient: transcript not on disk yet (SessionStart names it early)
  }
  if (size < offset) {
    return await downgrade(opts, digest, cursorKey, 'transcript_truncated', post);
  }

  const delta = readTranscriptDelta(opts.transcriptPath, offset);
  if (delta === null) return false;
  if (delta.lines.length === 0) return true;

  let records: TranscriptRecord[];
  try {
    records = parse(delta.lines);
  } catch {
    // The parsers are tolerant by construction; a throw is a defect, and the honest reading of
    // one is "this format is beyond this parser" — the downgrade contract, not a silent retry.
    return await downgrade(opts, digest, cursorKey, 'parse_failure', post);
  }

  const { allLanded, events } = await postTailRecords(records, {
    binding,
    dir: opts.dir,
    harness: opts.harness,
    digest,
    ...(opts.agentId ? { agentId: opts.agentId } : {}),
    post,
  });
  // Advance only when everything landed — a dropped delta is re-read by the next hook.
  if (allLanded || events === 0) {
    writeTailCursor(opts.dir, cursorKey, {
      path: opts.transcriptPath,
      offset: delta.nextOffset,
      updated_at: Date.now(),
    });
  }
  return allLanded && events > 0;
}

/**
 * Build and post one read's records — content only past the gates, in `TRACE_MAX_BATCH` chunks,
 * stopping at the first chunk that does not land. Shared by the file tail above and the OpenCode
 * store read (`opencode.ts`), which differ only in where the records come from and how their
 * cursor advances.
 */
export async function postTailRecords(
  records: readonly TranscriptRecord[],
  opts: {
    binding: Binding;
    dir: string;
    harness: string;
    digest: string;
    agentId?: string;
    post: (events: readonly TraceEvent[]) => Promise<boolean>;
  },
): Promise<{ allLanded: boolean; events: number }> {
  const content = traceContentEnabled(opts.binding, opts.dir);
  const events: TraceEvent[] = [];
  for (const record of records) {
    const event = buildTailEvent(record, {
      harness: opts.harness,
      digest: opts.digest,
      content,
      ...(opts.agentId ? { agentId: opts.agentId } : {}),
    });
    if (event) events.push(event);
  }
  for (let i = 0; i < events.length; i += TRACE_MAX_BATCH) {
    if (!(await opts.post(events.slice(i, i + TRACE_MAX_BATCH)))) {
      return { allLanded: false, events: events.length };
    }
  }
  return { allLanded: true, events: events.length };
}

async function downgrade(
  opts: { dir: string; harness: string; transcriptPath: string; agentId?: string },
  digest: string,
  cursorKey: string,
  reason: string,
  post: (events: readonly TraceEvent[]) => Promise<boolean>,
): Promise<boolean> {
  writeTailCursor(opts.dir, cursorKey, {
    path: opts.transcriptPath,
    offset: 0,
    updated_at: Date.now(),
    downgraded: true,
  });
  const marker = downgradeEvent(
    opts.harness,
    digest,
    transcriptParserVersion(opts.harness),
    reason,
    opts.agentId,
  );
  if (marker) await post([marker]);
  return false;
}

function transcriptParserVersion(harness: string): string {
  if (harness === 'codex') return CODEX_TRANSCRIPT_PARSER;
  if (harness === 'grok') return GROK_TRANSCRIPT_PARSER;
  if (harness === 'cursor') return CURSOR_TRANSCRIPT_PARSER;
  return CLAUDE_TRANSCRIPT_PARSER;
}
