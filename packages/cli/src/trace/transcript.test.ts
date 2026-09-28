import { describe, expect, it } from 'vitest';
import {
  CLAUDE_TRANSCRIPT_PARSER,
  CODEX_TRANSCRIPT_PARSER,
  CURSOR_TRANSCRIPT_PARSER,
  GROK_TRANSCRIPT_PARSER,
  parseClaudeTranscript,
  parseCodexTranscript,
  parseCursorTranscript,
  parseGrokTranscript,
  transcriptParserFor,
  UNKNOWN_RECORD_CAP,
} from './transcript.js';

/** A Claude Code assistant jsonl record — the real shape: one content block per LINE, the same
 *  `message.id` and `usage` repeated on every line of one API message (measured 2026-09-25). */
const claudeLine = (
  messageId: string,
  block: Record<string, unknown>,
  over: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: '2026-09-25T21:10:35.130Z',
    uuid: 'u-' + Math.random().toString(36).slice(2, 8),
    message: {
      id: messageId,
      model: 'claude-fable-5',
      content: [block],
      usage: {
        input_tokens: 2,
        output_tokens: 113,
        cache_read_input_tokens: 500,
        cache_creation_input_tokens: 77_500,
      },
      ...over,
    },
  });

describe('parseClaudeTranscript', () => {
  it('groups one API message across lines: blocks in order, ONE usage, joined by its tool_use', () => {
    const lines = [
      claudeLine('msg_1', { type: 'thinking', thinking: 'weigh the options', signature: 'x' }),
      claudeLine('msg_1', { type: 'text', text: 'On it.' }),
      claudeLine('msg_1', { type: 'tool_use', id: 'toolu_A', name: 'Bash' }),
    ];
    const records = parseClaudeTranscript(lines);
    expect(records.map((r) => [r.kind, r.tool_use_id])).toEqual([
      ['reasoning', 'toolu_A'],
      ['assistant_text', 'toolu_A'],
      ['usage', 'toolu_A'],
    ]);
    const [reasoning, text, usage] = records;
    expect(reasoning!.text).toBe('weigh the options');
    expect(reasoning!.detail).toEqual({
      parser: CLAUDE_TRANSCRIPT_PARSER,
      reasoning_bytes: 17,
    });
    expect(text!.text).toBe('On it.');
    expect(usage!.detail).toEqual({
      parser: CLAUDE_TRANSCRIPT_PARSER,
      model: 'claude-fable-5',
      input_tokens: 2,
      output_tokens: 113,
      cache_read_tokens: 500,
      cache_creation_tokens: 77_500,
      tool_uses: 1,
    });
    expect(usage!.ts).toBe(Date.parse('2026-09-25T21:10:35.130Z'));
  });

  it('recognised non-assistant types are silent skips; a novel type is `unknown`, never dropped', () => {
    const records = parseClaudeTranscript([
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' } }),
      JSON.stringify({ type: 'file-history-snapshot', snapshot: {} }),
      JSON.stringify({ type: 'brand-new-thing', payload: 1 }),
      'not json at all {{{',
    ]);
    expect(records.map((r) => [r.kind, r.detail['type'] ?? r.detail['parse_error']])).toEqual([
      ['unknown', 'brand-new-thing'],
      ['unknown', true],
    ]);
    expect(records.every((r) => typeof r.detail['bytes'] === 'number')).toBe(true);
  });

  it('caps unknown records and counts the suppressed on the last one', () => {
    const lines = Array.from({ length: UNKNOWN_RECORD_CAP + 5 }, (_, i) =>
      JSON.stringify({ type: `novel-${i}` }),
    );
    const records = parseClaudeTranscript(lines);
    expect(records).toHaveLength(UNKNOWN_RECORD_CAP);
    expect(records[records.length - 1]!.detail['suppressed']).toBe(5);
  });

  it('an empty (encrypted) thinking block still yields a structural reasoning record', () => {
    const records = parseClaudeTranscript([
      claudeLine('msg_2', { type: 'thinking', thinking: '', signature: 'sig' }),
    ]);
    expect(records.map((r) => r.kind)).toEqual(['reasoning', 'usage']);
    expect(records[0]!.text).toBeUndefined();
    expect(records[0]!.detail['reasoning_bytes']).toBe(0);
  });
});

/** A Codex rollout line (measured 2026-09-25 on a live rollout). */
const codexLine = (type: string, payload: Record<string, unknown>): string =>
  JSON.stringify({ timestamp: '2026-09-25T18:44:11.273Z', type, payload });

describe('parseCodexTranscript', () => {
  it('binds reasoning to the NEXT tool call, reads summaries, and one usage per token_usage_record', () => {
    const records = parseCodexTranscript([
      codexLine('session_meta', { session_id: 's1', cwd: '/w' }),
      codexLine('response_item', {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: '**Orienting**' }],
        encrypted_content: 'gAAA...',
      }),
      codexLine('response_item', {
        type: 'custom_tool_call',
        call_id: 'call_7',
        name: 'shell',
        input: '{}',
      }),
      // a delta that opens mid-call: this completion waits for the next usage record
      codexLine('event_msg', { type: 'item_completed', item: { type: 'McpToolCall' } }),
      codexLine('token_usage_record', {
        session_id: 's1',
        usage: {
          input_tokens: 24_940,
          cached_input_tokens: 20_000,
          output_tokens: 62,
          reasoning_output_tokens: 40,
          total_tokens: 25_002,
        },
      }),
      // one `exec` ran two nested tools: two completions, credited to the call that issued them
      codexLine('event_msg', { type: 'item_completed', item: { type: 'CommandExecution' } }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'CommandExecution' } }),
      codexLine('event_msg', { type: 'item_completed', item: { type: 'Reasoning' } }), // not a tool
      codexLine('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Done.' }],
      }),
      codexLine('event_msg', { type: 'token_count', info: {} }), // superseded — recognised skip
    ]);
    expect(records.map((r) => [r.kind, r.tool_use_id])).toEqual([
      ['reasoning', 'call_7'],
      ['usage', undefined],
      ['assistant_text', undefined],
    ]);
    expect(records[0]!.text).toBe('**Orienting**');
    expect(records[0]!.detail['encrypted']).toBe(true);
    expect(records[1]!.detail).toEqual({
      parser: CODEX_TRANSCRIPT_PARSER,
      input_tokens: 24_940,
      cache_read_tokens: 20_000,
      output_tokens: 62,
      reasoning_tokens: 40,
      total_tokens: 25_002,
      tool_uses: 3,
    });
  });

  it('flushes unjoined reasoning at an assistant message, and surfaces novel item types', () => {
    const records = parseCodexTranscript([
      codexLine('response_item', {
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'final thought' }],
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Answer.' }],
      }),
      codexLine('response_item', { type: 'hologram', data: 1 }),
      codexLine('world_state', { anything: true }),
    ]);
    expect(records.map((r) => [r.kind, r.tool_use_id ?? r.detail['type']])).toEqual([
      ['reasoning', undefined],
      ['assistant_text', undefined],
      ['unknown', 'response_item.hologram'],
    ]);
  });

  it('user and developer messages are recognised skips (they ride rail R1 as prompts)', () => {
    const records = parseCodexTranscript([
      codexLine('response_item', {
        type: 'message',
        role: 'developer',
        content: [{ type: 'input_text', text: 'instructions' }],
      }),
      codexLine('response_item', {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'do the thing' }],
      }),
    ]);
    expect(records).toEqual([]);
  });
});

/** A Grok `updates.jsonl` line — the real envelope (grok-4.7-build, measured 2026-09-28). */
const grokLine = (update: Record<string, unknown>, ms = 1_790_099_244_456): string =>
  JSON.stringify({
    timestamp: Math.floor(ms / 1000),
    method: '_x.ai/session/update',
    params: { sessionId: 's', update, _meta: { eventId: 'e', agentTimestampMs: ms } },
  });

describe('parseGrokTranscript', () => {
  it('coalesces chunks, joins reasoning to the next tool call, and counts tools per turn', () => {
    const records = parseGrokTranscript([
      grokLine({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } }),
      grokLine(
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'think ' } },
        1000,
      ),
      grokLine(
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'more' } },
        2000,
      ),
      grokLine({ sessionUpdate: 'tool_call', toolCallId: 'call_1', title: 'read_file' }),
      grokLine({ sessionUpdate: 'tool_call_update', toolCallId: 'call_1' }),
      grokLine({ sessionUpdate: 'hook_execution', event_name: 'pre_tool_use' }),
      grokLine({ sessionUpdate: 'tool_call', toolCallId: 'call_2', title: 'grep' }),
      grokLine(
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
        3000,
      ),
      grokLine(
        {
          sessionUpdate: 'turn_completed',
          usage: {
            inputTokens: 900,
            outputTokens: 50,
            cachedReadTokens: 600,
            cacheCreationTokens: 0,
            reasoningTokens: 40,
            totalTokens: 950,
            modelCalls: 3,
            costUsdTicks: 123,
          },
        },
        4000,
      ),
    ]);
    expect(records).toEqual([
      {
        kind: 'reasoning',
        ts: 1000,
        tool_use_id: 'call_1',
        detail: { parser: GROK_TRANSCRIPT_PARSER, reasoning_bytes: 10 },
        text: 'think more',
      },
      {
        kind: 'assistant_text',
        ts: 3000,
        detail: { parser: GROK_TRANSCRIPT_PARSER, assistant_bytes: 4 },
        text: 'done',
      },
      {
        kind: 'usage',
        ts: 4000,
        detail: {
          parser: GROK_TRANSCRIPT_PARSER,
          input_tokens: 900,
          output_tokens: 50,
          cache_read_tokens: 600,
          cache_creation_tokens: 0,
          reasoning_tokens: 40,
          total_tokens: 950,
          model_calls: 3,
          tool_uses: 2,
        },
      },
    ]);
  });

  it('is tolerant, never silent: a bad line and a novel update kind are `unknown`', () => {
    const records = parseGrokTranscript(['not json', grokLine({ sessionUpdate: 'brand_new' })]);
    expect(records.map((r) => [r.kind, r.detail['type'] ?? r.detail['parse_error']])).toEqual([
      ['unknown', true],
      ['unknown', 'brand_new'],
    ]);
  });
});

describe('parseCursorTranscript', () => {
  it('emits assistant text and one tokenless usage per turn with its tool count', () => {
    const line = (o: unknown): string => JSON.stringify(o);
    const records = parseCursorTranscript([
      line({ role: 'user', message: { content: [{ type: 'text', text: 'go' }] } }),
      line({
        role: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'reading' },
            { type: 'tool_use', name: 'Read', input: { path: 'a' } },
            { type: 'tool_use', name: 'Read', input: { path: 'b' } },
          ],
        },
      }),
      line({ role: 'assistant', message: { content: [{ type: 'tool_use', name: 'Shell' }] } }),
      line({ type: 'turn_ended', status: 'success' }),
      line({ type: 'turn_ended', status: 'success' }),
    ]);
    expect(records).toEqual([
      {
        kind: 'assistant_text',
        detail: { parser: CURSOR_TRANSCRIPT_PARSER, assistant_bytes: 7 },
        text: 'reading',
      },
      { kind: 'usage', detail: { parser: CURSOR_TRANSCRIPT_PARSER, tool_uses: 3 } },
      { kind: 'usage', detail: { parser: CURSOR_TRANSCRIPT_PARSER, tool_uses: 0 } },
    ]);
  });

  it("flushes calls after the last turn marker as the session's final turn", () => {
    const records = parseCursorTranscript([
      JSON.stringify({
        role: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Read' }] },
      }),
    ]);
    expect(records).toEqual([
      {
        kind: 'usage',
        detail: { parser: CURSOR_TRANSCRIPT_PARSER, tool_uses: 1, turn_marker: false },
      },
    ]);
  });
});

describe('transcriptParserFor', () => {
  it('ships Claude Code, Codex, Grok and Cursor; everything else is structural-only (ADR 445 §5)', () => {
    expect(transcriptParserFor('claude-code')).toBe(parseClaudeTranscript);
    expect(transcriptParserFor('codex')).toBe(parseCodexTranscript);
    expect(transcriptParserFor('grok')).toBe(parseGrokTranscript);
    expect(transcriptParserFor('cursor')).toBe(parseCursorTranscript);
    expect(transcriptParserFor('opencode')).toBeUndefined();
  });
});
