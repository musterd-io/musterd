import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lastGrokMessage,
  lastMuseMessage,
  lastOpencodeMessage,
  readTailLines,
} from './lastMessage.js';

function file(lines: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), 'last-message-')), 'log.jsonl');
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return path;
}

const grok = (update: Record<string, unknown>) => ({
  method: 'session/update',
  params: { sessionId: 'g1', update },
});
const chunk = (text: string) =>
  grok({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });

describe('lastGrokMessage (ADR 785)', () => {
  it('joins the trailing message chunks, past thoughts and the stop hook record', () => {
    const path = file([
      grok({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'go' } }),
      chunk('Earlier text before a tool.'),
      grok({ sessionUpdate: 'tool_call', toolCallId: 't1' }),
      grok({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } }),
      chunk('Merged.\n\n'),
      chunk('Want me to start 3b?'),
      grok({ sessionUpdate: 'hook_execution', event_name: 'stop', runs: [] }),
    ]);
    expect(lastGrokMessage(path)).toBe('Merged.\n\nWant me to start 3b?');
  });

  it('is undefined when the turn ended on a tool call, or the file is missing', () => {
    const path = file([chunk('Looking.'), grok({ sessionUpdate: 'tool_call', toolCallId: 't1' })]);
    expect(lastGrokMessage(path)).toBeUndefined();
    expect(lastGrokMessage('/nonexistent/updates.jsonl')).toBeUndefined();
  });
});

const museRun = (event: Record<string, unknown>) => ({
  payload_type: 'runtime.session',
  payload: { kind: 'run', run_id: 'r1', event },
});

describe('lastMuseMessage (ADR 785)', () => {
  it('reads the last committed message, past the bookkeeping after it', () => {
    const path = file([
      museRun({ kind: 'assistant_tool_calls_committed' }),
      museRun({ kind: 'assistant_message_committed', text: 'Which one: A or B?' }),
      museRun({ kind: 'model_completed' }),
      { payload_type: 'runtime.session', payload: { kind: 'task', task: { kind: 'completed' } } },
      museRun({ kind: 'hook_run_started', event: 'Stop' }),
    ]);
    expect(lastMuseMessage(path)).toBe('Which one: A or B?');
  });

  it('is undefined when a tool call or a new prompt followed the message', () => {
    expect(
      lastMuseMessage(
        file([
          museRun({ kind: 'assistant_message_committed', text: 'Ship it?' }),
          museRun({ kind: 'assistant_tool_calls_committed' }),
        ]),
      ),
    ).toBeUndefined();
    expect(
      lastMuseMessage(
        file([
          museRun({ kind: 'assistant_message_committed', text: 'Ship it?' }),
          { payload_type: 'runtime.user_intent.accepted', payload: {} },
        ]),
      ),
    ).toBeUndefined();
  });
});

describe('lastOpencodeMessage (ADR 785)', () => {
  const v2Row = (data: unknown) => JSON.stringify([{ data: JSON.stringify(data) }]);

  it('reads a v2 message that finished on stop', async () => {
    const run = async () =>
      v2Row({ finish: 'stop', content: [{ type: 'text', text: 'Done.\n\nWant me to merge?' }] });
    expect(await lastOpencodeMessage('ses_1', { run, dbPath: 'x' })).toBe(
      'Done.\n\nWant me to merge?',
    );
  });

  it('is undefined for a tool step, another finish, or no row', async () => {
    const tool = async () =>
      v2Row({ finish: 'stop', content: [{ type: 'text', text: 'ok?' }, { type: 'tool' }] });
    const length = async () =>
      v2Row({ finish: 'length', content: [{ type: 'text', text: 'ok?' }] });
    expect(await lastOpencodeMessage('s', { run: tool, dbPath: 'x' })).toBeUndefined();
    expect(await lastOpencodeMessage('s', { run: length, dbPath: 'x' })).toBeUndefined();
    expect(await lastOpencodeMessage('s', { run: async () => '', dbPath: 'x' })).toBeUndefined();
  });

  it('falls back to the v1 tables when the v2 table is missing', async () => {
    const run = async (_db: string, sql: string) =>
      sql.includes('session_message')
        ? null
        : JSON.stringify([
            {
              md: JSON.stringify({ role: 'assistant' }),
              pd: JSON.stringify({ type: 'step-start' }),
            },
            {
              md: JSON.stringify({ role: 'assistant' }),
              pd: JSON.stringify({ type: 'text', text: 'Go?' }),
            },
          ]);
    expect(await lastOpencodeMessage('s', { run, dbPath: 'x' })).toBe('Go?');
  });
});

describe('readTailLines', () => {
  it('drops the first line when the read starts mid-file', () => {
    const path = file(['a'.repeat(50), 'b', 'c']);
    expect(readTailLines(path, 10)).toEqual(['"b"', '"c"', '']);
  });
});
