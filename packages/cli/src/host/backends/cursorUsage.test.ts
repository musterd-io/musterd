import { describe, expect, it } from 'vitest';
import { parseCursorAgentResult } from './cursorUsage.js';

const result = (usage: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: false, ...extra, usage });

describe('parseCursorAgentResult', () => {
  it('maps the JSON result usage and drops a dollar field', () => {
    const text = result(
      { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, cacheWriteTokens: 1 },
      { total_cost_usd: 0.5 },
    );
    expect(parseCursorAgentResult(text)).toEqual({
      input_tokens: 10,
      output_tokens: 2,
      cached_input_tokens: 4,
      cache_write_input_tokens: 1,
    });
  });

  it('keeps a printed zero and omits a cache count the result left out', () => {
    expect(
      parseCursorAgentResult(result({ inputTokens: 3, outputTokens: 0, cacheReadTokens: 0 })),
    ).toEqual({
      input_tokens: 3,
      output_tokens: 0,
      cached_input_tokens: 0,
    });
  });

  it('uses the last result that has usage', () => {
    const text = [
      '{"type":"assistant","text":"partial"}',
      result({ inputTokens: 1, outputTokens: 1 }),
      result({ inputTokens: 8, outputTokens: 5, cacheWriteTokens: 2 }),
    ].join('\n');
    expect(parseCursorAgentResult(text)).toEqual({
      input_tokens: 8,
      output_tokens: 5,
      cache_write_input_tokens: 2,
    });
  });

  it('returns undefined when the run printed no usage — never zeros', () => {
    expect(parseCursorAgentResult('')).toBeUndefined();
    expect(parseCursorAgentResult('ActionRequiredError: limit\n')).toBeUndefined();
    expect(
      parseCursorAgentResult('{"type":"result","subtype":"success","result":"pong"}\n'),
    ).toBeUndefined();
    expect(
      parseCursorAgentResult('{"type":"result","usage":{"outputTokens":1}}\n'),
    ).toBeUndefined();
    expect(parseCursorAgentResult(result({ inputTokens: -1, outputTokens: 1 }))).toBeUndefined();
  });
});
