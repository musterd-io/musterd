import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type MutableModels,
} from '@earendil-works/pi-ai';
import type { WakeTranscriptLease } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import type { EngineTool, EngineTurn } from '../engine.js';
import { classifyPiFailure, piEngine, providerForModel } from './pi.js';
import { isPiTurnTranscript } from './rehydrate.js';

/**
 * The pi engine against pi-ai's faux provider (no socket, no key): the loop runs, tools are
 * bridged with their JSON schema, the jail blocks before execution, every turn is reported in the
 * replayable shape, history is seeded ahead of the prompt, and the end reasons map to the seam's.
 */

/** A faux "anthropic" so `claude-*` ids route to it without a real vendor. */
function faux(modelId = 'claude-faux'): {
  models: MutableModels;
  handle: ReturnType<typeof fauxProvider>;
} {
  const handle = fauxProvider({
    provider: 'anthropic',
    api: 'anthropic-messages',
    models: [{ id: modelId, cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }],
  });
  const models = createModels();
  models.setProvider(handle.provider);
  return { models, handle };
}

const tool = (name: string, run: EngineTool['run']): EngineTool => ({
  name,
  description: `the ${name} tool`,
  input_schema: {
    type: 'object',
    properties: { q: { type: 'string' } },
    additionalProperties: false,
  },
  run,
});

describe('providerForModel', () => {
  it('routes the three families the gateway fronts and refuses the rest', () => {
    expect(providerForModel('claude-opus-5-5')).toBe('anthropic');
    expect(providerForModel('gpt-6-sol')).toBe('openai');
    expect(providerForModel('o4-mini')).toBe('openai');
    expect(providerForModel('grok-4.7')).toBe('xai');
    expect(providerForModel('muse-spark-1.3')).toBeUndefined();
  });
});

describe('classifyPiFailure', () => {
  it('reads auth from the vendor refusals and the unconfigured-provider message (ADR 221)', () => {
    expect(classifyPiFailure('error', 'HTTP 401 Unauthorized')).toBe('auth');
    expect(classifyPiFailure('error', 'invalid x-api-key')).toBe('auth');
    expect(classifyPiFailure('error', 'Provider is not configured: anthropic')).toBe('auth');
    expect(classifyPiFailure('aborted', undefined)).toBe('aborted');
    expect(classifyPiFailure('error', 'overloaded')).toBe('error');
  });
});

describe('piEngine.run', () => {
  it('drives prompt → tool call → answer, reporting each turn in the replayable shape', async () => {
    const { models, handle } = faux();
    const calls: unknown[] = [];
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('team_next', { q: 'x' }, { id: 'c1' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('all done'),
    ]);
    const turns: EngineTurn[] = [];
    const result = await piEngine({ models }).run({
      model: 'claude-faux',
      prompt: 'You are izzo. Check your inbox.',
      tools: [
        tool('team_next', async (input) => {
          calls.push(input);
          return 'next — as izzo';
        }),
      ],
      onTurn: (t) => turns.push(t),
    });
    expect(result.end).toBe('completed');
    expect(result.turns).toBe(2);
    expect(calls).toEqual([{ q: 'x' }]);
    expect(turns.map((t) => t.index)).toEqual([1, 2]);
    expect(turns[0]!.stop_reason).toBe('toolUse');
    const first = turns[0]!.transcript;
    expect(isPiTurnTranscript(first)).toBe(true);
    expect(first).toMatchObject({
      v: 1,
      engine: 'pi',
      prompt: 'You are izzo. Check your inbox.',
      tool_results: [{ toolCallId: 'c1', isError: false }],
    });
    expect((turns[1]!.transcript as { prompt?: string }).prompt).toBeUndefined();
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    // An unknown model id prices to honest absence (no row), never a guess.
    expect(result.cost_usd).toBeUndefined();
  });

  it('prices turns from the host table when the model has a row', async () => {
    const { models, handle } = faux('claude-haiku-5-5');
    handle.setResponses([fauxAssistantMessage('hi')]);
    const result = await piEngine({ models }).run({
      model: 'claude-haiku-5-5',
      prompt: 'p',
      tools: [],
    });
    expect(result.cost_usd).toBeGreaterThan(0);
  });

  it('blocks a tool call the jail refuses before it runs, and the model sees the reason', async () => {
    const { models, handle } = faux();
    let ran = false;
    let seen: string | undefined;
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('bash', { q: 'rm -rf /' }, { id: 'c1' })], {
        stopReason: 'toolUse',
      }),
      (context) => {
        const last = context.messages[context.messages.length - 1];
        if (last && last.role === 'toolResult') {
          seen = (last.content[0] as { text: string }).text;
          expect(last.isError).toBe(true);
        }
        return fauxAssistantMessage('ok, stopping');
      },
    ]);
    const result = await piEngine({
      models,
      preflight: (name) => (name === 'bash' ? 'rm is not on the allowlist' : undefined),
    }).run({
      model: 'claude-faux',
      prompt: 'p',
      tools: [
        tool('bash', async () => {
          ran = true;
          return 'should not run';
        }),
      ],
    });
    expect(ran).toBe(false);
    expect(seen).toMatch(/denied: rm is not on the allowlist/);
    expect(result.end).toBe('completed');
  });

  it('seeds the context from captured leases ahead of the new prompt (ADR 588 amendment)', async () => {
    const { models, handle } = faux();
    let roles: string[] = [];
    handle.setResponses([
      (context) => {
        roles = context.messages.map((m) => m.role);
        return fauxAssistantMessage('continuing');
      },
    ]);
    const history: WakeTranscriptLease[] = [
      {
        lease_id: 'L0',
        created_at: 1,
        turns: [
          {
            turn: 1,
            usage: { input_tokens: 1, output_tokens: 1 },
            cost_usd: null,
            stop_reason: 'stop',
            created_at: 2,
            transcript: {
              v: 1,
              engine: 'pi',
              prompt: 'earlier wake',
              assistant: fauxAssistantMessage('I started the lane'),
              tool_results: [],
            },
          },
        ],
      },
    ];
    const tally: unknown[] = [];
    const result = await piEngine({ models, history, onRehydrate: (t) => tally.push(t) }).run({
      model: 'claude-faux',
      prompt: 'new wake',
      tools: [],
    });
    expect(result.end).toBe('completed');
    // No system prompt was given, so the transcript opens on the replayed wake.
    expect(roles).toEqual(['user', 'assistant', 'user']);
    expect(tally).toEqual([{ replayed: 1, skipped: 0, patched: 0 }]);
  });

  it('ADR 588 §6: a steered line becomes the next user turn, between tool calls, and rides the turn transcript', async () => {
    const { models, handle } = faux();
    let deliver: ((line: string) => void) | undefined;
    let unsubscribed = 0;
    const roles: string[][] = [];
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('team_next', {}, { id: 'c1' })], {
        stopReason: 'toolUse',
      }),
      (context) => {
        roles.push(
          context.messages
            .filter((m) => m.role !== 'system') // pi declares the tools in a leading system message
            .map((m) =>
              m.role === 'user'
                ? `user:${typeof m.content === 'string' ? m.content : m.content.map((c) => ('text' in c ? c.text : '')).join('')}`
                : m.role,
            ),
        );
        return fauxAssistantMessage('heard you');
      },
    ]);
    const turns: EngineTurn[] = [];
    const result = await piEngine({ models }).run({
      model: 'claude-faux',
      prompt: 'p',
      tools: [
        tool('team_next', async () => {
          // Raised while the tool runs: pi drains the steer after this batch, before the next request.
          deliver?.('⚡ musterd [revive]: steer from nick (steer) — read exactly it');
          return 'next — as izzo';
        }),
      ],
      steer: {
        subscribe: (d) => {
          deliver = d;
          return () => void (unsubscribed += 1);
        },
      },
      onTurn: (t) => turns.push(t),
    });
    expect(result.end).toBe('completed');
    // The second request saw: system?, user prompt, assistant(tool call), toolResult, then the steer.
    expect(roles[0]).toEqual([
      'user:p',
      'assistant',
      'toolResult',
      'user:⚡ musterd [revive]: steer from nick (steer) — read exactly it',
    ]);
    // The line is on the transcript of the turn it preceded, so a replay puts it where it ran.
    expect((turns[1]!.transcript as { steered?: string[] }).steered).toEqual([
      '⚡ musterd [revive]: steer from nick (steer) — read exactly it',
    ]);
    expect((turns[0]!.transcript as { steered?: string[] }).steered).toBeUndefined();
    expect(unsubscribed).toBe(1);
  });

  it('stops at the turn cap and reports max_turns when the model still wanted tools', async () => {
    const { models, handle } = faux();
    const wantsTool = () =>
      fauxAssistantMessage([fauxToolCall('t', {}, { id: `c${String(Math.random())}` })], {
        stopReason: 'toolUse',
      });
    handle.setResponses([wantsTool, wantsTool, wantsTool]);
    const result = await piEngine({ models }).run({
      model: 'claude-faux',
      prompt: 'p',
      tools: [tool('t', async () => 'r')],
      maxTurns: 2,
    });
    expect(result.turns).toBe(2);
    expect(result.end).toBe('max_turns');
  });

  it('classifies a provider error as error or auth from its message', async () => {
    const { models, handle } = faux();
    handle.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'HTTP 401 invalid x-api-key' }),
    ]);
    const auth = await piEngine({ models }).run({ model: 'claude-faux', prompt: 'p', tools: [] });
    expect(auth.end).toBe('auth');
    expect(auth.reason).toContain('401');
    handle.setResponses([
      fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded' }),
    ]);
    const err = await piEngine({ models }).run({ model: 'claude-faux', prompt: 'p', tools: [] });
    expect(err.end).toBe('error');
  });

  it('reports aborted when the watchdog fires, keeping the usage of turns that ran', async () => {
    const { models, handle } = faux();
    const controller = new AbortController();
    handle.setResponses([
      fauxAssistantMessage([fauxToolCall('slow', {}, { id: 'c1' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('never'),
    ]);
    const result = await piEngine({ models }).run({
      model: 'claude-faux',
      prompt: 'p',
      tools: [
        tool('slow', async () => {
          controller.abort();
          return 'r';
        }),
      ],
      signal: controller.signal,
    });
    expect(result.end).toBe('aborted');
    expect(result.turns).toBeGreaterThanOrEqual(1);
  });

  it('refuses a model id no provider owns, and an already-aborted signal, without a call', async () => {
    const { models } = faux();
    const none = await piEngine({ models }).run({
      model: 'muse-spark-1.3',
      prompt: 'p',
      tools: [],
    });
    expect(none).toMatchObject({ end: 'error', turns: 0 });
    expect(none.reason).toContain('no pi provider');
    const aborted = new AbortController();
    aborted.abort();
    const gone = await piEngine({ models }).run({
      model: 'claude-faux',
      prompt: 'p',
      tools: [],
      signal: aborted.signal,
    });
    expect(gone).toMatchObject({ end: 'aborted', turns: 0 });
  });

  it('points the model at the gateway for its provider and hands pi the operator key per call', async () => {
    const { models, handle } = faux();
    let seenBase: string | undefined;
    handle.setResponses([
      (_context, _options, _state, model) => {
        seenBase = model.baseUrl;
        return fauxAssistantMessage('ok');
      },
    ]);
    await piEngine({
      models,
      apiKey: 'sk-operator',
      gatewayEnv: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:1/anthropic' },
    }).run({ model: 'claude-faux', prompt: 'p', tools: [] });
    expect(seenBase).toBe('http://127.0.0.1:1/anthropic');
  });

  it('never lets a throwing onTurn observer kill the loop', async () => {
    const { models, handle } = faux();
    handle.setResponses([fauxAssistantMessage('ok')]);
    const result = await piEngine({ models }).run({
      model: 'claude-faux',
      prompt: 'p',
      tools: [],
      onTurn: () => {
        throw new Error('observer bug');
      },
    });
    expect(result.end).toBe('completed');
  });
});
