import { type WakeUsage } from '@musterd/protocol';
import { z } from 'zod';

/**
 * The usage reader for cursor-agent wakes (ADR 364). cursor-agent 2026.10.14-941492e
 * puts token counts on stdout only, and only for `--print --output-format json` or
 * `stream-json` (`--help` that day: default format is text, and text writes the answer
 * with no usage). The result line is `{type:"result", usage?:{inputTokens, outputTokens,
 * cacheReadTokens, cacheWriteTokens}}` and carries no dollar field. Transcript files do
 * not. A credentialed run on 2026-10-16 exited 1 on the $10 additional-usage cap with an
 * empty stdout, so this parser follows that build's writer, not a completed turn.
 * A miss is undefined — never zeros, never a throw. `cost_usd` is never set.
 */
const CursorUsage = z
  .object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
  })
  .passthrough();

const CursorResult = z
  .object({
    type: z.literal('result'),
    usage: CursorUsage.optional(),
  })
  .passthrough();

function toWakeUsage(usage: z.infer<typeof CursorUsage>): WakeUsage {
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    ...(usage.cacheReadTokens !== undefined ? { cached_input_tokens: usage.cacheReadTokens } : {}),
    ...(usage.cacheWriteTokens !== undefined
      ? { cache_write_input_tokens: usage.cacheWriteTokens }
      : {}),
  };
}

/**
 * The last `type:"result"` line in captured stdout that carries a usage object.
 * Earlier lines and a result with no usage object are ignored. The last one wins:
 * the print path emits one end-of-turn total, not per-step deltas.
 */
export function parseCursorAgentResult(text: string): WakeUsage | undefined {
  let usage: WakeUsage | undefined;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const parsed = CursorResult.safeParse(raw);
    if (!parsed.success || !parsed.data.usage) continue;
    usage = toWakeUsage(parsed.data.usage);
  }
  return usage;
}
