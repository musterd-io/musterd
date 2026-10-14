import type { WakeTranscriptLease } from '@musterd/protocol';
import { describe, expect, it } from 'vitest';
import { isPiTurnTranscript, rehydrate, type PiTurnTranscript } from './rehydrate.js';

/**
 * ADR 588 amendment: the daemon's rows are the resume substrate. Replay must produce a context
 * every provider accepts — tool calls answered, assistants never adjacent — from rows that may be
 * partial (a wake the watchdog cut), oversized (the capture marker), or another engine's shape.
 */

const assistant = (
  text: string,
  calls: { id: string; name: string }[] = [],
  stopReason: 'stop' | 'toolUse' = calls.length ? 'toolUse' : 'stop',
): PiTurnTranscript['assistant'] => ({
  role: 'assistant',
  content: [
    { type: 'text', text },
    ...calls.map((c) => ({ type: 'toolCall' as const, id: c.id, name: c.name, arguments: {} })),
  ],
  api: 'anthropic-messages',
  provider: 'anthropic',
  model: 'claude-test',
  usage: {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  stopReason,
  timestamp: 10,
});

const result = (id: string, name: string): PiTurnTranscript['tool_results'][number] => ({
  role: 'toolResult',
  toolCallId: id,
  toolName: name,
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
  timestamp: 11,
});

const row = (turn: number, transcript: unknown) => ({
  turn,
  usage: { input_tokens: 1, output_tokens: 1 },
  cost_usd: null,
  stop_reason: null,
  transcript,
  created_at: 100 + turn,
});

const lease = (id: string, turns: ReturnType<typeof row>[]): WakeTranscriptLease => ({
  lease_id: id,
  created_at: 50,
  turns,
});

describe('isPiTurnTranscript', () => {
  it('accepts the pi shape and refuses the phase-1 SDK shape and the oversize marker', () => {
    expect(
      isPiTurnTranscript({ v: 1, engine: 'pi', assistant: assistant('x'), tool_results: [] }),
    ).toBe(true);
    expect(isPiTurnTranscript({ assistant: [{ type: 'text' }], tool_results: null })).toBe(false);
    expect(isPiTurnTranscript({ truncated: true, bytes: 300000 })).toBe(false);
    expect(isPiTurnTranscript(null)).toBe(false);
  });
});

describe('rehydrate', () => {
  it('replays prompt, assistant and tool results in order across leases', () => {
    const r = rehydrate([
      lease('L1', [
        row(1, {
          v: 1,
          engine: 'pi',
          prompt: 'wake one',
          assistant: assistant('checking', [{ id: 'c1', name: 'team_next' }]),
          tool_results: [result('c1', 'team_next')],
        }),
        row(2, { v: 1, engine: 'pi', assistant: assistant('done'), tool_results: [] }),
      ]),
      lease('L2', [
        row(1, {
          v: 1,
          engine: 'pi',
          prompt: 'wake two',
          assistant: assistant('again'),
          tool_results: [],
        }),
      ]),
    ]);
    expect(r.messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'toolResult',
      'assistant',
      'user',
      'assistant',
    ]);
    expect(r).toMatchObject({ replayed: 3, skipped: 0, patched: 0 });
    expect(r.messages[0]).toMatchObject({ role: 'user', content: 'wake one' });
  });

  it('stands in for a tool result the wake never captured, as an error the model can see', () => {
    const r = rehydrate([
      lease('L1', [
        row(1, {
          v: 1,
          engine: 'pi',
          prompt: 'p',
          assistant: assistant('cut', [{ id: 'c1', name: 'bash' }]),
          tool_results: [],
        }),
      ]),
    ]);
    expect(r.patched).toBe(1);
    expect(r.messages[2]).toMatchObject({ role: 'toolResult', toolCallId: 'c1', isError: true });
  });

  it('skips rows that are not a pi transcript, keeps assistants apart, and notes a missing prompt', () => {
    const r = rehydrate([
      lease('L1', [
        row(1, { truncated: true, bytes: 400000 }),
        row(2, { v: 1, engine: 'pi', assistant: assistant('a'), tool_results: [] }),
        row(3, { v: 1, engine: 'pi', assistant: assistant('b'), tool_results: [] }),
      ]),
    ]);
    expect(r).toMatchObject({ replayed: 2, skipped: 1 });
    // No prompt was recorded on the surviving first row, so a note stands in for it; the two
    // consecutive assistants are separated by another note.
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(r.messages[0]).toMatchObject({ content: expect.stringMatching(/prompt not recorded/) });
  });

  it('is empty for no leases', () => {
    expect(rehydrate([])).toEqual({ messages: [], replayed: 0, skipped: 0, patched: 0 });
  });
});
