/**
 * Minimal Anthropic Messages client via fetch — no SDK dependency (ADR: env key only).
 */
import { ANTHROPIC_API_URL, ANTHROPIC_VERSION, LLM_TIMEOUT_MS, USER_AGENT } from './config.ts';
import type { FetchFn } from './fetch.ts';

export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface LlmCompleteArgs {
  model: string;
  system: string;
  messages: LlmMessage[];
  maxTokens?: number;
  apiKey: string;
  fetchFn?: FetchFn | undefined;
}

export interface LlmCompleteResult {
  text: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function completeAnthropic(args: LlmCompleteArgs): Promise<LlmCompleteResult> {
  const fetchFn = args.fetchFn ?? fetch;
  const maxAttempts = 3;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), LLM_TIMEOUT_MS);
    try {
      const res = await fetchFn(ANTHROPIC_API_URL, {
        method: 'POST',
        signal: ctrl.signal,
        headers: {
          'content-type': 'application/json',
          'User-Agent': USER_AGENT,
          'x-api-key': args.apiKey,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: JSON.stringify({
          model: args.model,
          max_tokens: args.maxTokens ?? 4096,
          system: args.system,
          messages: args.messages.map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        const body = await res.text().catch(() => '');
        lastError = new Error(`Anthropic ${res.status}: ${body.slice(0, 400)}`);
        // Retry after backoff on transient provider errors.
        if (attempt < maxAttempts - 1) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
          continue;
        }
        throw lastError;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`Anthropic ${res.status}: ${body.slice(0, 400)}`);
      }
      const data = (await res.json()) as {
        content?: Array<{ type: string; text?: string }>;
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      const text = (data.content ?? [])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text!)
        .join('\n')
        .trim();
      if (!text) throw new Error('Anthropic response had no text blocks');
      return {
        text,
        model: data.model ?? args.model,
        ...(data.usage?.input_tokens !== undefined ? { inputTokens: data.usage.input_tokens } : {}),
        ...(data.usage?.output_tokens !== undefined
          ? { outputTokens: data.usage.output_tokens }
          : {}),
      };
    } catch (err) {
      lastError = err;
      // Retry on network/abort errors too, but only if not the last attempt.
      if (attempt < maxAttempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

/** Extract the first JSON value (object or array) from a model reply.
 *
 * Model replies are not always clean JSON: they may be fenced in ```json, may carry prose
 * before or after the value, and a long triage reply can be *truncated* at max_tokens, leaving
 * an unterminated array. We (1) strip a code fence, (2) locate the first `{` or `[`, (3) walk
 * to the matching close by depth, and (4) on truncation, recover the longest prefix that is
 * itself valid JSON by trimming trailing incomplete elements. Returning *something* beats a
 * `provider_or_response_error` warning that hides the whole week's triage.
 */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced?.[1]?.trim() ?? text.trim();
  const startObj = raw.indexOf('{');
  const startArr = raw.indexOf('[');
  let start = -1;
  let open = '';
  let close = '';
  if (startObj >= 0 && (startArr < 0 || startObj < startArr)) {
    start = startObj;
    open = '{';
    close = '}';
  } else if (startArr >= 0) {
    start = startArr;
    open = '[';
    close = ']';
  }
  if (start < 0) throw new Error('no JSON object/array in model reply');
  const slice = raw.slice(start);
  // Walk to the matching close.
  let depth = 0;
  let inStr = false;
  let esc = false;
  let end = -1;
  for (let i = 0; i < slice.length; i++) {
    const ch = slice[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const candidate = end >= 0 ? slice.slice(0, end) : slice;
  try {
    return JSON.parse(candidate);
  } catch {
    // Truncated reply: try to salvage a complete array by dropping the trailing partial element.
    if (open === '[') {
      for (let i = candidate.length - 1; i >= 0; i--) {
        if (candidate[i] !== '}') continue;
        try {
          return JSON.parse(candidate.slice(0, i + 1) + ']');
        } catch {
          // keep trying
        }
      }
    }
    // Last resort: rethrow the original parse error for the caller to surface.
    return JSON.parse(slice);
  }
}

export function requireAnthropicKey(env: NodeJS.ProcessEnv = process.env): string {
  const key = env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    throw new Error(
      'ANTHROPIC_API_KEY is required for --triage (tier-1/tier-2 LLM). Export it or skip --triage for dry-sweep only.',
    );
  }
  return key;
}
