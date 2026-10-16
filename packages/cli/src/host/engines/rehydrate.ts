import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type {
  Api,
  AssistantMessage,
  JsonObject,
  Model,
  ToolResultMessage,
} from '@earendil-works/pi-ai';
import type { WakeTranscriptLease } from '@musterd/protocol';
import type { SteerRead } from '../engine.js';

/**
 * The transcript shape the pi engine writes into each `wake_turns` row, and the replay of those
 * rows into the next wake's context (ADR 588 amendment: the daemon's rows are the canonical,
 * provider-neutral transcript and the resume substrate — not a library's storage).
 *
 * pi-ai's normalized `AssistantMessage` / `ToolResultMessage` are already vendor-neutral (one
 * shape across Anthropic, OpenAI and xAI), which is what makes wake N+1 on another model
 * replayable from wake N. The first turn of a lease also records the wake prompt, so the replay
 * carries what the seat was asked, not only what it did.
 */

export const PI_TRANSCRIPT_VERSION = 1 as const;

/**
 * ADR 627: a read the host performed for a steered act and put in the loop as a tool exchange.
 * Recorded here, apart from `assistant`, because no model made this call — the record says so.
 */
export interface PiHostRead {
  /** Index into `steered`: the line this read followed. */
  line: number;
  tool_call_id: string;
  tool: string;
  args: Record<string, unknown>;
  result: string;
}

export interface PiTurnTranscript {
  v: typeof PI_TRANSCRIPT_VERSION;
  engine: 'pi';
  /** The daemon-composed wake line — on the lease's first turn only. */
  prompt?: string;
  /** ADR 588 §6: the daemon-composed lines steered into the loop ahead of this turn's request. */
  steered?: string[];
  /** ADR 627: the host reads that followed those lines, in the order they ran. */
  host_reads?: PiHostRead[];
  assistant: AssistantMessage;
  tool_results: ToolResultMessage[];
}

/**
 * ADR 627: the host's read of a steered act as the tool exchange it stands for — an assistant
 * message holding exactly that one call, then its result. Zero usage (no model produced it; no
 * `turn_end` fires for it, so it is never a `wake_turns` row or a cost), and the run's own
 * api/provider/model so pi-ai replays it as same-model. Its provenance is the transcript's
 * `host_reads`, never the `assistant` field a model turn writes.
 */
export function hostReadMessages(
  model: Pick<Model<Api>, 'api' | 'provider' | 'id'>,
  read: SteerRead,
  id: string,
  timestamp: number,
): [AssistantMessage, ToolResultMessage] {
  return [
    {
      role: 'assistant',
      content: [{ type: 'toolCall', id, name: read.tool, arguments: read.args as JsonObject }],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'toolUse',
      timestamp,
    },
    {
      role: 'toolResult',
      toolCallId: id,
      toolName: read.tool,
      content: [{ type: 'text', text: read.result }],
      isError: false,
      timestamp,
    },
  ];
}

export function isPiTurnTranscript(t: unknown): t is PiTurnTranscript {
  if (!t || typeof t !== 'object') return false;
  const o = t as Record<string, unknown>;
  if (o['v'] !== PI_TRANSCRIPT_VERSION || o['engine'] !== 'pi') return false;
  const a = o['assistant'] as Record<string, unknown> | undefined;
  if (!a || a['role'] !== 'assistant' || !Array.isArray(a['content'])) return false;
  return Array.isArray(o['tool_results']);
}

export interface Rehydrated {
  messages: AgentMessage[];
  /** Turns replayed verbatim. */
  replayed: number;
  /** Rows that were not a pi transcript (another engine's shape, or an oversized-turn marker). */
  skipped: number;
  /** Tool calls whose result was never captured — stood in for, so the transcript stays legal. */
  patched: number;
}

const note = (text: string, timestamp: number): AgentMessage => ({
  role: 'user',
  content: `[musterd] ${text}`,
  timestamp,
});

/**
 * Replay captured leases (oldest first) into the messages that precede the new wake's prompt.
 * Invariants kept so no provider rejects the context: every tool call is followed by a result
 * (missing ones are stood in for as errors), and two assistant messages never touch.
 */
export function rehydrate(leases: readonly WakeTranscriptLease[]): Rehydrated {
  const messages: AgentMessage[] = [];
  let replayed = 0;
  let skipped = 0;
  let patched = 0;
  const lastRole = (): string | undefined => messages[messages.length - 1]?.role;

  for (const lease of leases) {
    const turns = [...lease.turns].sort((a, b) => a.turn - b.turn);
    let first = true;
    for (const row of turns) {
      const t = row.transcript;
      if (!isPiTurnTranscript(t)) {
        skipped += 1;
        continue;
      }
      if (first) {
        messages.push(
          t.prompt !== undefined
            ? { role: 'user', content: t.prompt, timestamp: lease.created_at }
            : note(`wake ${lease.lease_id}: prompt not recorded`, lease.created_at),
        );
      } else if (lastRole() === 'assistant' && !(t.steered && t.steered.length > 0)) {
        messages.push(note('continued', row.created_at));
      }
      first = false;
      // A steered line was a user turn when it ran; replay it as one, where it ran — and the host
      // read that followed it (ADR 627) as the tool exchange it was, so the replay matches the run.
      const reads = Array.isArray(t.host_reads) ? t.host_reads : [];
      (t.steered ?? []).forEach((line, i) => {
        if (typeof line !== 'string' || line.length === 0) return;
        messages.push({ role: 'user', content: line, timestamp: row.created_at });
        for (const r of reads) {
          if (r.line !== i || typeof r.tool_call_id !== 'string' || typeof r.result !== 'string')
            continue;
          messages.push(
            ...hostReadMessages(
              { api: t.assistant.api, provider: t.assistant.provider, id: t.assistant.model },
              { tool: r.tool, args: r.args, result: r.result },
              r.tool_call_id,
              row.created_at,
            ),
          );
        }
      });
      const assistant: AssistantMessage = {
        ...t.assistant,
        timestamp: t.assistant.timestamp ?? row.created_at,
      };
      messages.push(assistant);
      const results = new Map(t.tool_results.map((r) => [r.toolCallId, r]));
      for (const block of assistant.content) {
        if (block.type !== 'toolCall') continue;
        const found = results.get(block.id);
        if (found) {
          messages.push({ ...found, timestamp: found.timestamp ?? row.created_at });
        } else {
          patched += 1;
          messages.push({
            role: 'toolResult',
            toolCallId: block.id,
            toolName: block.name,
            content: [{ type: 'text', text: '(result not recorded — the wake ended here)' }],
            isError: true,
            timestamp: row.created_at,
          });
        }
      }
      replayed += 1;
    }
  }
  return { messages, replayed, skipped, patched };
}
