import { Agent, type AgentTool, type StreamFn } from '@earendil-works/pi-agent-core';
import {
  createModels,
  type Api,
  type Model,
  type MutableModels,
  type TSchema,
} from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { xaiProvider } from '@earendil-works/pi-ai/providers/xai';
import type { WakeTranscriptLease } from '@musterd/protocol';
import type {
  AgentLoopEngine,
  EngineRunResult,
  EngineRunSpec,
  EngineTurn,
  EngineUsage,
} from '../engine.js';
import { priceUsage } from '../prices.js';
import { rehydrate, type PiTurnTranscript } from './rehydrate.js';

/**
 * The pi engine (ADR 588 §3 as amended): `@earendil-works/pi-agent-core` runs the turn and
 * `@earendil-works/pi-ai` speaks to the vendors; musterd owns everything around it. The second
 * {@link AgentLoopEngine} implementation, and the one every native wake runs on — the ADR 251
 * phase-1 SDK runner is gone (ADR 588 Consequences). pi's API moves; this file is the one place it
 * is touched (the ADR 251 blast-radius rule).
 *
 * What rides where:
 * - the model comes resolved (ADR 101 env > binding) and is never defaulted here; its provider is
 *   read off the id prefix, and an id pi's catalog does not know is still run — synthesized with
 *   the provider's api and zero catalog cost, because the host's price table and the gateway price
 *   the turn, not pi;
 * - the ADR 583 gateway fronts every call: the model's `baseUrl` is the gateway's for that
 *   provider, so the budget refusal and the metered rows apply to this engine like every harness;
 * - the key is the operator's (`--key-env`), handed to pi per call through `getApiKey` and never
 *   logged; absent, pi's own env resolution applies;
 * - every tool is an {@link EngineTool} (musterd's bridged surface and the jailed working tools
 *   alike); the raw JSON schema is the tool's parameters, which pi compiles and the vendor sees;
 * - `preflight` is the jail (ADR 588 §4): a reason blocks the call before it runs, and the block
 *   is a tool result the model reads and the `wake_turns` row records;
 * - every completed turn is reported with pi's normalized assistant message and tool results as
 *   the transcript (`rehydrate.ts`), and `history` — the daemon's rows for the seat's earlier
 *   wakes — seeds the context, so wake N+1 continues wake N on whichever model this one runs.
 */

/** Output cap per turn — a working seat writes files through tools, not through prose. */
const MAX_TOKENS_PER_TURN = 16_000;

type PiProvider = 'anthropic' | 'openai' | 'xai';

/** The gateway variable each provider's base URL is taken from (`host/gateway.ts` upstreams). */
const GATEWAY_ENV: Record<PiProvider, string> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
  xai: 'GROK_MODELS_BASE_URL',
};

const PROVIDER_API: Record<PiProvider, Api> = {
  anthropic: 'anthropic-messages',
  openai: 'openai-responses',
  xai: 'openai-responses',
};

/** The provider a model id names, by prefix — the same families the gateway fronts. */
export function providerForModel(model: string): PiProvider | undefined {
  const id = model.trim().toLowerCase();
  if (id.startsWith('claude-')) return 'anthropic';
  if (/^(gpt-|o[1-9]|codex)/.test(id)) return 'openai';
  if (id.startsWith('grok-')) return 'xai';
  return undefined;
}

export interface PiEngineOptions {
  /** The operator's API key, read at spawn from `--key-env`. Never logged. */
  apiKey?: string | undefined;
  /** ADR 583: the per-wake gateway's base-URL variables; the provider's URL is rewritten to it. */
  gatewayEnv?: Record<string, string> | undefined;
  /** The seat's earlier captured leases (oldest first), replayed ahead of this wake's prompt. */
  history?: readonly WakeTranscriptLease[] | undefined;
  systemPrompt?: string | undefined;
  /** The jail: a denial reason blocks the tool call; undefined lets it run. */
  preflight?: ((name: string, args: unknown) => string | undefined) | undefined;
  /** Test seam: a prepared `Models` collection (the faux provider) instead of the real vendors. */
  models?: MutableModels | undefined;
  /** Observer for the rehydration tally (one narrator line in the backend). */
  onRehydrate?:
    | ((tally: { replayed: number; skipped: number; patched: number }) => void)
    | undefined;
}

const emptyUsage = (): EngineUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
});

/** pi-ai's usage (`input` excludes the cache, as Anthropic reports it) → the seam's fields. */
function toEngineUsage(u: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}): EngineUsage {
  return {
    input_tokens: u.input,
    output_tokens: u.output,
    cache_read_input_tokens: u.cacheRead,
    cache_creation_input_tokens: u.cacheWrite,
  };
}

/**
 * Auth failures are the deferral signal (a machine property, ADR 221): a 401, a key the vendor
 * refused, or a provider pi reports as not configured at all (no key reached it). An abort is the
 * watchdog. Everything else is a work failure.
 */
export function classifyPiFailure(
  stopReason: string | undefined,
  message: string | undefined,
): 'auth' | 'aborted' | 'error' {
  if (stopReason === 'aborted') return 'aborted';
  const m = message ?? '';
  if (
    /\b401\b|unauthori[sz]ed|authentication|invalid (x-)?api[- ]?key|x-api-key|not configured|no api key|missing api key/i.test(
      m,
    )
  )
    return 'auth';
  return 'error';
}

function synthesizeModel(provider: PiProvider, id: string, baseUrl: string): Model<Api> {
  return {
    id,
    name: id,
    api: PROVIDER_API[provider],
    provider,
    baseUrl,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    reasoning: false,
    contextWindow: 200_000,
    maxTokens: MAX_TOKENS_PER_TURN,
  };
}

function toAgentTool(
  tool: EngineRunSpec['tools'][number],
  preflight: PiEngineOptions['preflight'],
): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // The MCP render's JSON schema, verbatim: pi compiles plain JSON Schema and the vendor sees
    // exactly what the adapter published (the musterd server validates inputs itself, ADR 144).
    parameters: tool.input_schema as unknown as TSchema,
    executionMode: 'sequential',
    execute: async (_id, params) => {
      // The jail is the before-tool hook; this is the belt to that brace for a call that reached
      // execute by any other route (pi's `runToolCall`, a future codemode).
      const reason = preflight?.(tool.name, params);
      if (reason) throw new Error(`denied: ${reason}`);
      const text = await tool.run(params);
      return { content: [{ type: 'text', text }], details: undefined };
    },
  };
}

export function piEngine(opts: PiEngineOptions = {}): AgentLoopEngine {
  return {
    provider: 'pi',

    async run(spec: EngineRunSpec): Promise<EngineRunResult> {
      const totals = emptyUsage();
      const failed = (end: 'auth' | 'error', reason: string): EngineRunResult => ({
        turns: 0,
        end,
        usage: totals,
        reason: reason.slice(0, 200),
      });

      const provider = providerForModel(spec.model);
      if (!provider) return failed('error', `no pi provider for model "${spec.model}"`);
      const models = opts.models ?? createModels();
      if (!models.getProvider(provider)) {
        models.setProvider(
          provider === 'anthropic'
            ? anthropicProvider()
            : provider === 'openai'
              ? openaiProvider()
              : xaiProvider(),
        );
      }
      const registered = models.getProvider(provider);
      const catalog = models.getModel(provider, spec.model);
      const gatewayUrl = opts.gatewayEnv?.[GATEWAY_ENV[provider]];
      const base = catalog ?? synthesizeModel(provider, spec.model, registered?.baseUrl ?? '');
      const model: Model<Api> = gatewayUrl ? { ...base, baseUrl: gatewayUrl } : base;

      const history = opts.history?.length ? rehydrate(opts.history) : undefined;
      if (history) {
        try {
          opts.onRehydrate?.({
            replayed: history.replayed,
            skipped: history.skipped,
            patched: history.patched,
          });
        } catch {
          // observer bugs never kill the run
        }
      }

      const streamFn: StreamFn = (m, context, options) =>
        models.streamSimple(m, context, { ...options, maxTokens: MAX_TOKENS_PER_TURN });

      let turnsSeen = 0;
      let cappedByTurns = false;
      const agent = new Agent({
        initialState: {
          ...(opts.systemPrompt !== undefined ? { systemPrompt: opts.systemPrompt } : {}),
          model,
          tools: spec.tools.map((t) => toAgentTool(t, opts.preflight)),
          messages: history?.messages ?? [],
        },
        streamFn,
        ...(opts.apiKey !== undefined ? { getApiKey: () => opts.apiKey } : {}),
        toolExecution: 'sequential',
        beforeToolCall: async ({ toolCall, args }) => {
          const reason = opts.preflight?.(toolCall.name, args);
          return reason ? { block: true, reason: `denied: ${reason}` } : undefined;
        },
        finishTurn: (turn) => {
          turnsSeen += 1;
          if (spec.maxTurns !== undefined && turnsSeen >= spec.maxTurns) {
            cappedByTurns =
              turn.message.role === 'assistant' && turn.message.stopReason === 'toolUse';
            return { action: 'end' };
          }
          return undefined;
        },
      });

      let costTotal: number | undefined;
      let lastStop: string | undefined;
      let lastError: string | undefined;
      agent.subscribe((event) => {
        if (event.type !== 'turn_end' || event.message.role !== 'assistant') return;
        const message = event.message;
        const usage = toEngineUsage(message.usage);
        totals.input_tokens += usage.input_tokens;
        totals.output_tokens += usage.output_tokens;
        totals.cache_read_input_tokens += usage.cache_read_input_tokens;
        totals.cache_creation_input_tokens += usage.cache_creation_input_tokens;
        const cost = priceUsage(spec.model, usage);
        if (cost !== undefined) costTotal = (costTotal ?? 0) + cost;
        lastStop = message.stopReason;
        lastError = message.errorMessage;
        const transcript: PiTurnTranscript = {
          v: 1,
          engine: 'pi',
          ...(turnsSeen === 1 ? { prompt: spec.prompt } : {}),
          assistant: message,
          tool_results: event.toolResults,
        };
        const turn: EngineTurn = {
          index: turnsSeen,
          usage,
          cost_usd: cost,
          stop_reason: message.stopReason,
          transcript,
        };
        try {
          spec.onTurn?.(turn);
        } catch {
          // Observer bugs must never kill the run — capture is best-effort by design.
        }
      });

      if (spec.signal?.aborted) return { turns: 0, end: 'aborted', usage: totals };
      const onAbort = (): void => agent.abort();
      spec.signal?.addEventListener('abort', onAbort, { once: true });
      let thrown: unknown;
      try {
        await agent.prompt(spec.prompt);
      } catch (err) {
        thrown = err;
      } finally {
        spec.signal?.removeEventListener('abort', onAbort);
      }

      const result = (end: EngineRunResult['end'], reason?: string): EngineRunResult => ({
        turns: turnsSeen,
        end,
        usage: totals,
        cost_usd: costTotal,
        ...(reason !== undefined ? { reason: reason.slice(0, 200) } : {}),
      });
      if (thrown !== undefined) {
        const message = (thrown as Error).message ?? String(thrown);
        const end = spec.signal?.aborted ? 'aborted' : classifyPiFailure(undefined, message);
        return result(end, message);
      }
      if (lastStop === 'aborted' || spec.signal?.aborted) return result('aborted');
      if (lastStop === 'error') {
        const message = lastError ?? agent.state.errorMessage ?? 'pi reported an error';
        return result(classifyPiFailure('error', message), message);
      }
      if (cappedByTurns) return result('max_turns');
      return result('completed');
    },
  };
}
