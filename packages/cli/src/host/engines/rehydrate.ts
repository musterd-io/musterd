import type { AgentMessage } from '@earendil-works/pi-agent-core';
import type { AssistantMessage, ToolResultMessage } from '@earendil-works/pi-ai';
import type { WakeTranscriptLease } from '@musterd/protocol';

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

export interface PiTurnTranscript {
  v: typeof PI_TRANSCRIPT_VERSION;
  engine: 'pi';
  /** The daemon-composed wake line — on the lease's first turn only. */
  prompt?: string;
  assistant: AssistantMessage;
  tool_results: ToolResultMessage[];
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
      } else if (lastRole() === 'assistant') {
        messages.push(note('continued', row.created_at));
      }
      first = false;
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
