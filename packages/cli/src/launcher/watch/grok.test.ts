import { describe, expect, it } from 'vitest';
import { endedCleanly, grokReader, watchEvents } from './grok.js';

const upd = (update: object, extra: object = {}, timestamp = 1791465029) =>
  JSON.stringify({
    timestamp,
    method: 'session/update',
    params: { sessionId: 'S', update, _meta: { agentTimestampMs: 1791465029030, ...extra } },
  });
const chunk = (text: string) =>
  upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

// Shapes copied from real updates.jsonl (2026-10-08); contents invented.
const lines = [
  upd({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'USER PROMPT' } }),
  upd({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'SECRET THOUGHT' } }),
  chunk("I'll read the "),
  upd({ sessionUpdate: 'hook_execution', hook: 'musterd' }),
  chunk('packet first.'),
  upd({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'read_file',
    rawInput: { target_file: '/w/packet.md' },
  }),
  upd({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    title: 'Read `/w/packet.md`',
    rawInput: { variant: 'ReadFile', target_file: '/w/packet.md' },
    content: [{ type: 'content', content: { type: 'text', text: 'FILE CONTENTS SECRET' } }],
  }),
  upd({
    sessionUpdate: 'tool_call',
    toolCallId: 'call-2',
    title: 'run_terminal_cmd',
    rawInput: { command: 'ls -la' },
  }),
  upd({ sessionUpdate: 'turn_completed', usage: { inputTokens: 1 } }),
  'not json',
];

describe('Grok watchEvents (ADR 546)', () => {
  it('joins streamed chunks into one message and shows the tool calls, in order', () => {
    expect(watchEvents(lines).map((e) => e.line)).toEqual([
      "“I'll read the packet first.”",
      '▸ read_file  /w/packet.md',
      '▸ run_terminal_cmd  ls -la',
    ]);
  });

  it('never shows results, thoughts, hooks or the user turn', () => {
    const text = watchEvents(lines)
      .map((e) => e.line)
      .join('\n');
    for (const secret of ['FILE CONTENTS SECRET', 'SECRET THOUGHT', 'USER PROMPT', 'hook'])
      expect(text).not.toContain(secret);
  });

  it('holds back a message still streaming, so a poll never prints half a sentence', () => {
    expect(watchEvents([chunk('half a sen')])).toEqual([]);
    expect(watchEvents([chunk('half a sen'), chunk('tence')])).toEqual([]);
    expect(
      watchEvents([chunk('whole'), upd({ sessionUpdate: 'turn_completed' })]).map((e) => e.line),
    ).toEqual(['“whole”']);
  });

  it('scrubs a credential and strips escapes', () => {
    const key = 'mskey_abcdefabcdefabcdefabcdef0123456789';
    const evil = [
      chunk(`key ${key}\u001b[2J`),
      upd({
        sessionUpdate: 'tool_call',
        title: 'run_terminal_cmd',
        rawInput: { command: `echo ${key}\u001b]0;x\u0007` },
      }),
    ];
    for (const e of watchEvents(evil)) {
      expect(e.line).not.toContain('mskey_abcdef');
      // eslint-disable-next-line no-control-regex
      expect(e.line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });

  it('carries the agent timestamp', () => {
    expect(watchEvents(lines)[0]!.ts).toBe(1791465029030);
  });
});

describe('Grok endedCleanly (ADR 546)', () => {
  it('is true when the last real update is turn_completed, whatever bookkeeping follows', () => {
    expect(endedCleanly(lines.slice(0, 9))).toBe(true);
    expect(endedCleanly([...lines.slice(0, 9), upd({ sessionUpdate: 'hook_execution' })])).toBe(
      true,
    );
    expect(endedCleanly(lines.slice(0, 8))).toBe(false);
    expect(endedCleanly([])).toBe(false);
  });
});

describe('grokReader (ADR 546)', () => {
  const wake = {
    lease_id: 'L',
    pid: 1,
    session_id: 'S-1',
    harness: 'grok',
    started_at: 1,
    workspace: '/w',
  };
  it('finds the transcript from the session id and workspace', () => {
    let asked: [string, string] | undefined;
    const r = grokReader({
      transcriptPath: (id, ws) => ((asked = [id, ws]), '/u.jsonl'),
      readLines: () => lines,
    });
    expect(r.snapshot(wake)).toMatchObject({ endedCleanly: true });
    expect(asked).toEqual(['S-1', '/w']);
    expect(r.snapshot(wake)!.events).toHaveLength(3);
  });
  it('is null with no session id or no file, and the default path refuses a hostile id', () => {
    expect(grokReader({ transcriptPath: () => undefined }).snapshot(wake)).toBeNull();
    expect(grokReader().snapshot({ ...wake, session_id: null })).toBeNull();
    expect(
      grokReader({ readLines: () => lines }).snapshot({ ...wake, session_id: '../../x' }),
    ).toBeNull();
  });
});
