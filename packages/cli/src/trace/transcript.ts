/**
 * Rail R2, the transcript parsers (ADR 445 §2, increment 2). Each harness persists its sessions in
 * its own on-disk shape; these turn a batch of transcript lines into the three R2 record kinds —
 * `reasoning`, `assistant_text`, `usage` — plus `unknown` for anything unrecognised.
 *
 * Three properties are the contract, per the ADR:
 *
 * - **Version-stamped.** Every record carries `detail.parser` (`claude-code@1`, `codex@1`), so a
 *   reader can tell which parser's idea of the format produced a row after the format shifts.
 * - **Tolerant, never silent.** The harness's on-disk format is NOT a contract (Anthropic says so).
 *   A line that fails to parse, or a record type this parser has never seen, is emitted as
 *   `{kind:'unknown', detail:{bytes,…}}` — never dropped. Types the parser KNOWS and deliberately
 *   does not emit (a user message R1 already saw as a prompt, a tool_result R1 carries as
 *   tool_response) are recognised skips, so `unknown` stays a real signal.
 * - **Text is separate from structure.** A record's prose (`text`) is returned raw here and gated,
 *   scrubbed and bounded by the tail (`tail.ts`) — the parser never decides whether content flows.
 */

/** Parser stamps — bump the suffix when the parse logic changes shape, not on refactors. */
export const CLAUDE_TRANSCRIPT_PARSER = 'claude-code@1';
export const CODEX_TRANSCRIPT_PARSER = 'codex@2';
export const GROK_TRANSCRIPT_PARSER = 'grok@1';
export const CURSOR_TRANSCRIPT_PARSER = 'cursor@1';

/** How many `unknown` records one parse may emit — a novel benign type must surface, not flood.
 *  The last one carries `detail.suppressed` with the count that hit the cap. */
export const UNKNOWN_RECORD_CAP = 8;

/** One R2 record, parsed but not yet an event: the tail owns ts fallback, content gating, digest. */
export interface TranscriptRecord {
  kind: 'reasoning' | 'assistant_text' | 'usage' | 'unknown';
  /** The record's own timestamp (epoch ms) when the transcript carries one. */
  ts?: number;
  /** Join key to rail R1 when derivable (the tool call this reasoning/message led to). */
  tool_use_id?: string;
  detail: Record<string, string | number | boolean | null>;
  /** Raw prose (reasoning / assistant text) — unscrubbed, unbounded; the tail gates it. */
  text?: string;
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);

function isoToMs(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : undefined;
}

function bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/** Emit an `unknown` under the cap; count what the cap suppressed onto the last emitted one. */
class UnknownBudget {
  private emitted = 0;
  private suppressed = 0;
  private last: TranscriptRecord | undefined;

  push(out: TranscriptRecord[], record: TranscriptRecord): void {
    if (this.emitted < UNKNOWN_RECORD_CAP) {
      this.emitted++;
      this.last = record;
      out.push(record);
      return;
    }
    this.suppressed++;
    if (this.last) this.last.detail['suppressed'] = this.suppressed;
  }
}

/* -------------------------------- Claude Code ~/.claude/projects -------------------------------- */

/** Top-level record types the Claude parser KNOWS and deliberately never emits: user turns and tool
 *  results ride rail R1 (prompt / tool_response), the rest is harness bookkeeping. Measured on live
 *  transcripts 2026-09-25; a type outside this set and `assistant` is `unknown` by contract. */
const CLAUDE_SKIP_TYPES = new Set([
  'user',
  'system',
  'summary',
  'progress',
  'attachment',
  'file-history-snapshot',
  'mode',
  'permission-mode',
  'ai-title',
  'atis-latch',
  'bridge-session',
  'last-prompt',
  'queued-command',
  'compact-boundary',
  'todo',
  'plan',
]);

interface ClaudeGroup {
  ts?: number | undefined;
  model?: string | undefined;
  usage?: Record<string, unknown> | undefined;
  toolUseIds: string[];
  /** In content-block order across the group's lines: thinking and text blocks. */
  blocks: { kind: 'reasoning' | 'assistant_text'; text: string }[];
}

/**
 * Parse a delta of Claude Code transcript lines. One API message arrives as SEVERAL jsonl records —
 * same `message.id`, one content block each, the same `usage` repeated on every one — so records are
 * grouped by `message.id` first: one `usage` per message (not per line), and the message's first
 * `tool_use` block's id joins every record of the group to rail R1.
 */
export function parseClaudeTranscript(lines: readonly string[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const unknowns = new UnknownBudget();
  const groups = new Map<string, ClaudeGroup>();
  const order: string[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      const json: unknown = JSON.parse(line);
      if (typeof json !== 'object' || json === null) throw new Error('not an object');
      o = json as Record<string, unknown>;
    } catch {
      unknowns.push(out, {
        kind: 'unknown',
        detail: { parser: CLAUDE_TRANSCRIPT_PARSER, bytes: bytes(line), parse_error: true },
      });
      continue;
    }
    const type = str(o['type']);
    if (type === 'assistant') {
      collectClaudeAssistant(o, groups, order);
      continue;
    }
    if (type !== undefined && CLAUDE_SKIP_TYPES.has(type)) continue;
    unknowns.push(out, {
      kind: 'unknown',
      detail: {
        parser: CLAUDE_TRANSCRIPT_PARSER,
        bytes: bytes(line),
        ...(type ? { type: type.slice(0, 64) } : {}),
      },
    });
  }

  for (const id of order) {
    const g = groups.get(id)!;
    const join = g.toolUseIds[0];
    for (const block of g.blocks) {
      out.push({
        kind: block.kind,
        ...(g.ts !== undefined ? { ts: g.ts } : {}),
        ...(join ? { tool_use_id: join } : {}),
        detail: {
          parser: CLAUDE_TRANSCRIPT_PARSER,
          [block.kind === 'reasoning' ? 'reasoning_bytes' : 'assistant_bytes']: bytes(block.text),
        },
        ...(block.text ? { text: block.text } : {}),
      });
    }
    const u = g.usage;
    if (u) {
      out.push({
        kind: 'usage',
        ...(g.ts !== undefined ? { ts: g.ts } : {}),
        ...(join ? { tool_use_id: join } : {}),
        detail: {
          parser: CLAUDE_TRANSCRIPT_PARSER,
          ...(g.model ? { model: g.model.slice(0, 128) } : {}),
          ...pickTokens(u, {
            input_tokens: 'input_tokens',
            output_tokens: 'output_tokens',
            cache_read_tokens: 'cache_read_input_tokens',
            cache_creation_tokens: 'cache_creation_input_tokens',
          }),
          tool_uses: g.toolUseIds.length,
        },
      });
    }
  }
  return out;
}

function collectClaudeAssistant(
  o: Record<string, unknown>,
  groups: Map<string, ClaudeGroup>,
  order: string[],
): void {
  const message = o['message'];
  if (typeof message !== 'object' || message === null) return;
  const m = message as Record<string, unknown>;
  // A message with no id still groups — by line, which loses only the usage dedupe.
  const id = str(m['id']) ?? `line-${order.length}-${groups.size}`;
  let g = groups.get(id);
  if (!g) {
    g = { toolUseIds: [], blocks: [] };
    groups.set(id, g);
    order.push(id);
  }
  g.ts ??= isoToMs(o['timestamp']);
  g.model ??= str(m['model']);
  const usage = m['usage'];
  if (g.usage === undefined && typeof usage === 'object' && usage !== null) {
    g.usage = usage as Record<string, unknown>;
  }
  const content = m['content'];
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    const type = str(b['type']);
    if (type === 'thinking') {
      g.blocks.push({ kind: 'reasoning', text: str(b['thinking']) ?? '' });
    } else if (type === 'text') {
      g.blocks.push({ kind: 'assistant_text', text: str(b['text']) ?? '' });
    } else if (type === 'tool_use') {
      const toolId = str(b['id']);
      if (toolId) g.toolUseIds.push(toolId);
    }
    // redacted_thinking, server_tool_use, … — recognised structure inside a known record type;
    // nothing to emit and nothing unknown about the LINE, so no `unknown` record either.
  }
}

/** Copy the token counters a usage object carries onto detail under our column spellings. */
function pickTokens(
  usage: Record<string, unknown>,
  map: Record<string, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [ours, theirs] of Object.entries(map)) {
    const v = num(usage[theirs]);
    if (v !== undefined) out[ours] = v;
  }
  return out;
}

/* ---------------------------------- Codex ~/.codex/sessions ---------------------------------- */

/** Top-level rollout types the Codex parser knows and never emits. `event_msg` is handled apart
 *  (its `token_count` is superseded by `token_usage_record`, which carries the same counters plus
 *  turn identity — emitting both would double every usage row). */
const CODEX_SKIP_TYPES = new Set([
  'session_meta',
  'turn_context',
  'compacted',
  'world_state',
  'event_msg',
]);

/** `response_item` payload types recognised and skipped: the call and its output ride rail R1. */
const CODEX_SKIP_ITEMS = new Set([
  'custom_tool_call',
  'custom_tool_call_output',
  'function_call',
  'function_call_output',
  'web_search_call',
  'local_shell_call',
  'local_shell_call_output',
]);

/**
 * The `event_msg.item_completed` item types that are a tool codex ran — the unit a codex hook fires
 * on, so the unit R2 counts as `tool_uses` (codex@2). Not the `custom_tool_call` response items: in
 * code mode one `exec` call runs several nested tools and the hook fires for each, so counting
 * `exec` calls read R1 at 128% of R2. Measured on one 2026-09-26 rollout: 205 CommandExecution
 * against R1's 205 Bash, 7 FileChange against 7 apply_patch; 340 items against 343 R1 calls.
 */
const CODEX_TOOL_ITEMS: ReadonlySet<string> = new Set([
  'CommandExecution',
  'McpToolCall',
  'FileChange',
  'Extension',
]);

/**
 * Parse a delta of Codex rollout lines. Codex writes reasoning and the tool call it led to as
 * SEPARATE `response_item` records, so the join is positional: a reasoning item binds to the next
 * tool call's `call_id` in the same delta (flushed unjoined at an assistant message or the delta's
 * end). Reasoning bodies are encrypted at rest — what the rollout has in the clear is the summary,
 * and that is what `text` carries; `detail.encrypted` says when a body existed that we cannot read.
 */
export function parseCodexTranscript(lines: readonly string[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const unknowns = new UnknownBudget();
  /** Reasoning records waiting for the tool call that follows them. */
  let pending: TranscriptRecord[] = [];
  /** codex@2: a tool completes AFTER the usage record of the model call that issued it, so a
   *  completion is credited to the latest usage record in this delta; one that arrives before any
   *  (a delta that opens mid-call) waits for the next. */
  let lastUsage: TranscriptRecord | undefined;
  let unclaimed = 0;
  const flush = (toolUseId?: string): void => {
    for (const r of pending) {
      if (toolUseId) r.tool_use_id = toolUseId;
      out.push(r);
    }
    pending = [];
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown>;
    try {
      const json: unknown = JSON.parse(line);
      if (typeof json !== 'object' || json === null) throw new Error('not an object');
      o = json as Record<string, unknown>;
    } catch {
      unknowns.push(out, {
        kind: 'unknown',
        detail: { parser: CODEX_TRANSCRIPT_PARSER, bytes: bytes(line), parse_error: true },
      });
      continue;
    }
    const type = str(o['type']);
    const ts = isoToMs(o['timestamp']);
    const payload =
      typeof o['payload'] === 'object' && o['payload'] !== null
        ? (o['payload'] as Record<string, unknown>)
        : undefined;

    if (type === 'response_item' && payload) {
      const itemType = str(payload['type']);
      if (itemType === 'reasoning') {
        const summary = Array.isArray(payload['summary']) ? payload['summary'] : [];
        const text = summary
          .map((s) =>
            typeof s === 'object' && s !== null
              ? (str((s as Record<string, unknown>)['text']) ?? '')
              : '',
          )
          .filter(Boolean)
          .join('\n\n');
        pending.push({
          kind: 'reasoning',
          ...(ts !== undefined ? { ts } : {}),
          detail: {
            parser: CODEX_TRANSCRIPT_PARSER,
            reasoning_bytes: bytes(text),
            encrypted: str(payload['encrypted_content']) !== undefined,
          },
          ...(text ? { text } : {}),
        });
        continue;
      }
      if (itemType === 'message') {
        if (str(payload['role']) === 'assistant') {
          flush();
          const content = Array.isArray(payload['content']) ? payload['content'] : [];
          for (const block of content) {
            if (typeof block !== 'object' || block === null) continue;
            const text = str((block as Record<string, unknown>)['text']) ?? '';
            out.push({
              kind: 'assistant_text',
              ...(ts !== undefined ? { ts } : {}),
              detail: { parser: CODEX_TRANSCRIPT_PARSER, assistant_bytes: bytes(text) },
              ...(text ? { text } : {}),
            });
          }
        }
        continue; // user/developer messages ride rail R1 as prompts — recognised skips
      }
      if (itemType !== undefined && CODEX_SKIP_ITEMS.has(itemType)) {
        const callId = str(payload['call_id']);
        if (callId && (itemType === 'custom_tool_call' || itemType === 'function_call')) {
          flush(callId);
        }
        continue;
      }
      unknowns.push(out, {
        kind: 'unknown',
        detail: {
          parser: CODEX_TRANSCRIPT_PARSER,
          bytes: bytes(line),
          ...(itemType ? { type: `response_item.${itemType}`.slice(0, 64) } : {}),
        },
      });
      continue;
    }

    if (type === 'token_usage_record' && payload) {
      const usage =
        typeof payload['usage'] === 'object' && payload['usage'] !== null
          ? (payload['usage'] as Record<string, unknown>)
          : {};
      out.push({
        kind: 'usage',
        ...(ts !== undefined ? { ts } : {}),
        detail: {
          parser: CODEX_TRANSCRIPT_PARSER,
          ...pickTokens(usage, {
            input_tokens: 'input_tokens',
            output_tokens: 'output_tokens',
            cache_read_tokens: 'cached_input_tokens',
            reasoning_tokens: 'reasoning_output_tokens',
            total_tokens: 'total_tokens',
          }),
          tool_uses: unclaimed,
        },
      });
      lastUsage = out[out.length - 1];
      unclaimed = 0;
      continue;
    }

    if (type === 'event_msg' && payload && str(payload['type']) === 'item_completed') {
      const item = payload['item'];
      const itemType =
        typeof item === 'object' && item !== null
          ? str((item as Record<string, unknown>)['type'])
          : undefined;
      if (itemType !== undefined && CODEX_TOOL_ITEMS.has(itemType)) {
        if (lastUsage)
          lastUsage.detail['tool_uses'] = Number(lastUsage.detail['tool_uses'] ?? 0) + 1;
        else unclaimed++;
      }
      continue;
    }

    if (type !== undefined && CODEX_SKIP_TYPES.has(type)) continue;
    unknowns.push(out, {
      kind: 'unknown',
      detail: {
        parser: CODEX_TRANSCRIPT_PARSER,
        bytes: bytes(line),
        ...(type ? { type: type.slice(0, 64) } : {}),
      },
    });
  }
  flush();
  return out;
}

/* ------------------------- Grok $GROK_HOME/sessions/<cwd>/<id>/updates.jsonl ------------------------- */

/** `sessionUpdate` kinds the Grok parser KNOWS and never emits: tool-call progress and hook runs
 *  are rail R1's, user chunks ride R1 as prompts, the rest is session bookkeeping. Measured over
 *  every local Grok session (11,333 update lines, grok-4.7-build) on 2026-09-28. */
const GROK_SKIP_UPDATES = new Set([
  'tool_call_update',
  'hook_execution',
  'hook_annotation',
  'user_message_chunk',
  'task_backgrounded',
  'task_completed',
  'background_tasks',
  'plan',
  'retry_state',
  'session_recap',
  'auto_compact_started',
  'auto_compact_completed',
  'compaction_checkpoint',
  'current_mode_update',
]);

const obj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;

/**
 * Parse a delta of Grok `updates.jsonl` — the ACP-style session-update stream, the one Grok file
 * that is both timestamped and complete (`chat_history.jsonl` has neither timestamps nor usage).
 * Reasoning and assistant text arrive as `*_chunk` updates; consecutive chunks of one kind are one
 * record. A reasoning record joins the NEXT `tool_call`'s id, as Codex's does. Each
 * `turn_completed` carries the turn's token totals and is one `usage` record, whose `tool_uses` is
 * the `tool_call` count since the previous one in this delta.
 *
 * `turn_completed` is written AFTER Grok's Stop hook runs (3 of 3 wanderer sessions, 2026-09-28),
 * so a Stop-time read would split a turn's calls from its usage. Grok's R2 therefore rides
 * SessionEnd, which Grok fires after the last `turn_completed`.
 */
export function parseGrokTranscript(lines: readonly string[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const unknowns = new UnknownBudget();
  let chunk: { kind: 'reasoning' | 'assistant_text'; ts?: number; text: string } | undefined;
  let pendingReasoning: TranscriptRecord[] = [];
  let toolCalls = 0;
  const flushChunk = (): void => {
    if (!chunk) return;
    const record: TranscriptRecord = {
      kind: chunk.kind,
      ...(chunk.ts !== undefined ? { ts: chunk.ts } : {}),
      detail: {
        parser: GROK_TRANSCRIPT_PARSER,
        [chunk.kind === 'reasoning' ? 'reasoning_bytes' : 'assistant_bytes']: bytes(chunk.text),
      },
      ...(chunk.text ? { text: chunk.text } : {}),
    };
    if (chunk.kind === 'reasoning') pendingReasoning.push(record);
    else out.push(record);
    chunk = undefined;
  };
  const flushReasoning = (toolUseId?: string): void => {
    for (const r of pendingReasoning) {
      if (toolUseId) r.tool_use_id = toolUseId;
      out.push(r);
    }
    pendingReasoning = [];
  };

  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown> | undefined;
    try {
      o = obj(JSON.parse(line));
    } catch {
      o = undefined;
    }
    const params = obj(o?.['params']);
    const update = obj(params?.['update']);
    if (!o || !update) {
      unknowns.push(out, {
        kind: 'unknown',
        detail: { parser: GROK_TRANSCRIPT_PARSER, bytes: bytes(line), parse_error: true },
      });
      continue;
    }
    const agentMs = num(obj(params?.['_meta'])?.['agentTimestampMs']);
    const secs = num(o['timestamp']);
    const ts = agentMs ?? (secs !== undefined ? secs * 1000 : undefined);
    const type = str(update['sessionUpdate']);

    if (type === 'agent_thought_chunk' || type === 'agent_message_chunk') {
      const kind = type === 'agent_thought_chunk' ? 'reasoning' : 'assistant_text';
      const text = str(obj(update['content'])?.['text']) ?? '';
      if (chunk?.kind !== kind) {
        flushChunk();
        chunk = { kind, ...(ts !== undefined ? { ts } : {}), text: '' };
      }
      chunk.text += text;
      continue;
    }
    flushChunk();
    if (type === 'tool_call') {
      toolCalls++;
      flushReasoning(str(update['toolCallId']));
      continue;
    }
    if (type === 'turn_completed') {
      flushReasoning();
      const usage = obj(update['usage']) ?? {};
      out.push({
        kind: 'usage',
        ...(ts !== undefined ? { ts } : {}),
        detail: {
          parser: GROK_TRANSCRIPT_PARSER,
          ...pickTokens(usage, {
            input_tokens: 'inputTokens',
            output_tokens: 'outputTokens',
            cache_read_tokens: 'cachedReadTokens',
            cache_creation_tokens: 'cacheCreationTokens',
            reasoning_tokens: 'reasoningTokens',
            total_tokens: 'totalTokens',
            model_calls: 'modelCalls',
          }),
          tool_uses: toolCalls,
        },
      });
      toolCalls = 0;
      continue;
    }
    if (type !== undefined && GROK_SKIP_UPDATES.has(type)) continue;
    unknowns.push(out, {
      kind: 'unknown',
      detail: {
        parser: GROK_TRANSCRIPT_PARSER,
        bytes: bytes(line),
        ...(type ? { type: type.slice(0, 64) } : {}),
      },
    });
  }
  flushChunk();
  flushReasoning();
  return out;
}

/* ------------------ Cursor ~/.cursor/projects/<slug>/agent-transcripts/<id>/<id>.jsonl ------------------ */

/**
 * Parse a delta of Cursor agent transcript lines: `{role, message:{content:[…]}}` records and a
 * `{type:'turn_ended'}` marker per turn. The file carries no timestamps, no token counts and no
 * reasoning (measured over every local Cursor transcript, 53,306 assistant records, 2026-09-28), so
 * what R2 can say for Cursor is assistant text and, per turn, how many tools it called: one
 * `usage` record per `turn_ended` with `tool_uses` and no token fields. That is enough for the
 * coverage ratio and deliberately nothing more — a zero is not invented where a count is absent.
 */
export function parseCursorTranscript(lines: readonly string[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  const unknowns = new UnknownBudget();
  let toolUses = 0;
  let firstToolUse: string | undefined;
  for (const line of lines) {
    if (!line.trim()) continue;
    let o: Record<string, unknown> | undefined;
    try {
      o = obj(JSON.parse(line));
    } catch {
      o = undefined;
    }
    if (!o) {
      unknowns.push(out, {
        kind: 'unknown',
        detail: { parser: CURSOR_TRANSCRIPT_PARSER, bytes: bytes(line), parse_error: true },
      });
      continue;
    }
    const role = str(o['role']);
    if (role === 'assistant') {
      const content = obj(o['message'])?.['content'];
      for (const block of Array.isArray(content) ? content : []) {
        const b = obj(block);
        const type = str(b?.['type']);
        if (type === 'text') {
          const text = str(b?.['text']) ?? '';
          out.push({
            kind: 'assistant_text',
            detail: { parser: CURSOR_TRANSCRIPT_PARSER, assistant_bytes: bytes(text) },
            ...(text ? { text } : {}),
          });
        } else if (type === 'tool_use') {
          toolUses++;
          firstToolUse ??= str(b?.['id']);
        }
      }
      continue;
    }
    if (role === 'user') continue; // rides rail R1 as the prompt
    const type = str(o['type']);
    if (type === 'turn_ended') {
      out.push({
        kind: 'usage',
        ...(firstToolUse ? { tool_use_id: firstToolUse } : {}),
        detail: { parser: CURSOR_TRANSCRIPT_PARSER, tool_uses: toolUses },
      });
      toolUses = 0;
      firstToolUse = undefined;
      continue;
    }
    unknowns.push(out, {
      kind: 'unknown',
      detail: {
        parser: CURSOR_TRANSCRIPT_PARSER,
        bytes: bytes(line),
        ...((type ?? role) ? { type: (type ?? role)!.slice(0, 64) } : {}),
      },
    });
  }
  // Older transcripts carry no `turn_ended` at all (664 markers over 53,306 assistant records).
  // Cursor's R2 is read once, at SessionEnd, so the end of the delta is the end of the session:
  // calls after the last marker are that session's final turn, not calls to drop.
  if (toolUses > 0) {
    out.push({
      kind: 'usage',
      ...(firstToolUse ? { tool_use_id: firstToolUse } : {}),
      detail: { parser: CURSOR_TRANSCRIPT_PARSER, tool_uses: toolUses, turn_marker: false },
    });
  }
  return out;
}

/** The parser for a harness, or undefined — R2 shipped Claude Code and Codex first (ADR 445 §5);
 *  Grok and Cursor followed (lane 01M3MGQ93W). */
export function transcriptParserFor(
  harness: string,
): ((lines: readonly string[]) => TranscriptRecord[]) | undefined {
  if (harness === 'claude-code') return parseClaudeTranscript;
  if (harness === 'codex') return parseCodexTranscript;
  if (harness === 'grok') return parseGrokTranscript;
  if (harness === 'cursor') return parseCursorTranscript;
  return undefined;
}
