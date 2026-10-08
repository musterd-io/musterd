import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexReader, codexRolloutPath, endedCleanly, watchEvents } from './codex.js';

const rec = (type: string, payload: object, timestamp = '2026-10-03T17:35:00.000Z') =>
  JSON.stringify({ timestamp, type, payload });
const done = (item: object, timestamp?: string) =>
  rec('event_msg', { type: 'item_completed', thread_id: 'T-1', turn_id: 'u1', item }, timestamp);

// Shapes copied from real rollouts (2026-10-03); contents invented.
const lines = [
  rec('session_meta', { id: 'T-1', cwd: '/w' }),
  rec('event_msg', { type: 'task_started', turn_id: 'u1' }),
  done({ type: 'UserMessage', content: [{ type: 'text', text: 'USER PROMPT TEXT' }] }),
  done({ type: 'Reasoning', summary_text: ['**Thinking about it**'], raw_content: [] }),
  done(
    {
      type: 'AgentMessage',
      content: [{ type: 'Text', text: "I'll check the\ninbox." }],
      phase: 'commentary',
    },
    '2026-10-03T17:35:02.000Z',
  ),
  done({
    type: 'CommandExecution',
    command: ['/bin/zsh', '-lc', "rg --files -g 'SKILL.md' . | head"],
    aggregated_output: 'COMMAND OUTPUT SECRET',
  }),
  done({
    type: 'McpToolCall',
    server: 'musterd',
    tool: 'team_inbox_check',
    arguments: { unread_only: true, id: '01M4ECTQRF' },
    result: { content: [{ type: 'text', text: 'MCP RESULT SECRET' }] },
  }),
  done({
    type: 'FileChange',
    changes: { '/w/packages/a.ts': { type: 'update', unified_diff: '+DIFF SECRET' } },
  }),
  rec('response_item', { type: 'function_call_output', output: 'CALL OUTPUT SECRET' }),
  rec('event_msg', { type: 'task_complete', turn_id: 'u1', last_agent_message: 'LAST MSG' }),
  'not json',
];

describe('Codex watchEvents (ADR 546)', () => {
  it('shows its words and the tools it ran, in order', () => {
    expect(watchEvents(lines).map((e) => e.line)).toEqual([
      "“I'll check the inbox.”",
      "▸ Bash  rg --files -g 'SKILL.md' . | head",
      '▸ team_inbox_check  01M4ECTQRF',
      '▸ apply_patch  /w/packages/a.ts',
    ]);
  });

  it('never shows outputs, results, diffs, reasoning or the user turn', () => {
    const text = watchEvents(lines)
      .map((e) => e.line)
      .join('\n');
    for (const secret of [
      'COMMAND OUTPUT SECRET',
      'MCP RESULT SECRET',
      'DIFF SECRET',
      'CALL OUTPUT SECRET',
      'Thinking about it',
      'USER PROMPT TEXT',
    ])
      expect(text).not.toContain(secret);
  });

  it('scrubs a credential and strips escapes from words and commands', () => {
    const key = 'mskey_abcdefabcdefabcdefabcdef0123456789';
    const evil = [
      done({ type: 'AgentMessage', content: [{ type: 'Text', text: `key ${key}\u001b[2J` }] }),
      done({ type: 'CommandExecution', command: ['sh', '-c', `echo ${key}\u001b]0;x\u0007`] }),
    ];
    for (const e of watchEvents(evil)) {
      expect(e.line).not.toContain('mskey_abcdef');
      // eslint-disable-next-line no-control-regex
      expect(e.line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });

  it('carries the record timestamp', () => {
    expect(watchEvents(lines)[0]!.ts).toBe(Date.parse('2026-10-03T17:35:02.000Z'));
  });
});

describe('Codex endedCleanly (ADR 546)', () => {
  it('is true only when the last turn boundary is task_complete', () => {
    expect(endedCleanly(lines)).toBe(true);
    expect(endedCleanly(lines.slice(0, 8))).toBe(false); // task_started, no completion
    expect(
      endedCleanly([
        ...lines.slice(0, 9),
        rec('event_msg', { type: 'turn_aborted', reason: 'interrupted' }),
      ]),
    ).toBe(false);
    expect(endedCleanly([])).toBe(false);
  });
});

describe('codexRolloutPath (ADR 546)', () => {
  const home = mkdtempSync(join(tmpdir(), 'codexhome-'));
  const day = join(home, '.codex', 'sessions', '2026', '10', '03');
  mkdirSync(day, { recursive: true });
  const file = join(day, 'rollout-2026-10-03T17-34-53-T-1.jsonl');
  writeFileSync(file, '');
  writeFileSync(join(day, 'rollout-2026-10-03T17-00-00-OTHER.jsonl'), '');

  it('finds the rollout whose name ends with the thread id', () => {
    expect(codexRolloutPath('T-1', home)).toBe(file);
    expect(codexRolloutPath('T-2', home)).toBeUndefined();
  });

  it('refuses an id that could be a path', () => {
    expect(codexRolloutPath('../../etc/passwd', home)).toBeUndefined();
    expect(codexRolloutPath('a/b', home)).toBeUndefined();
  });
});

describe('codexReader (ADR 546)', () => {
  const wake = {
    lease_id: 'L',
    pid: 1,
    session_id: 'T-1',
    harness: 'codex',
    started_at: 1,
    workspace: '/w',
  };
  it('snapshots events + whether it ended cleanly, and looks the file up once', () => {
    let lookups = 0;
    const r = codexReader({
      rolloutPath: () => (lookups++, '/r.jsonl'),
      readLines: () => lines,
    });
    expect(r.snapshot(wake)).toMatchObject({ endedCleanly: true });
    r.snapshot(wake);
    expect(lookups).toBe(1);
    expect(r.snapshot(wake)!.events).toHaveLength(4);
  });
  it('is null with no session id or no rollout yet', () => {
    expect(codexReader({ rolloutPath: () => undefined }).snapshot(wake)).toBeNull();
    expect(codexReader().snapshot({ ...wake, session_id: null })).toBeNull();
  });
});
