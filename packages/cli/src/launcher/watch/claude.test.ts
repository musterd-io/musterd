import { describe, expect, it } from 'vitest';
import { claudeReader, endedCleanly, watchEvents } from './claude.js';

const rec = (o: object) => JSON.stringify(o);
const lines = [
  rec({
    type: 'assistant',
    timestamp: '2026-10-07T16:27:00Z',
    message: {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'text',
          text: "The umbrella's three PRs are merged;\nchecking main has all of them.",
        },
        {
          type: 'tool_use',
          name: 'Bash',
          input: { command: 'git log --oneline origin/main -5', description: 'x' },
        },
      ],
    },
  }),
  rec({ type: 'user', message: { content: [{ type: 'tool_result', content: 'SECRET OUTPUT' }] } }),
  rec({
    type: 'assistant',
    timestamp: '2026-10-07T16:29:00Z',
    message: {
      stop_reason: 'tool_use',
      content: [
        {
          type: 'tool_use',
          name: 'mcp__musterd__lane_submit',
          input: { id: '01M46YWG8YHEV2SKW9F1N0W8FG' },
        },
      ],
    },
  }),
  rec({
    type: 'assistant',
    message: {
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'export KEY=mskey_abcdefabcdefabcdefabcdef0123456789' }],
    },
  }),
  'not json',
];

describe('Claude Code watchEvents (ADR 546)', () => {
  it('reads words and tool calls, never tool results', () => {
    const got = watchEvents(lines).map((e) => e.line);
    expect(got).toHaveLength(4);
    expect(got.slice(0, 3)).toEqual([
      "“The umbrella's three PRs are merged; checking main has all of them.”",
      '▸ Bash  git log --oneline origin/main -5',
      '▸ lane_submit  01M46YWG8YHEV2SKW9F1N0W8FG',
    ]);
    expect(got.join('\n')).not.toContain('SECRET OUTPUT');
  });

  it('scrubs a credential in the words', () => {
    const last = watchEvents(lines).at(-1)!.line;
    expect(last).not.toContain('mskey_abcdef');
    expect(last).toContain('<redacted:');
  });

  it('carries the record timestamp, or null', () => {
    const ev = watchEvents(lines);
    expect(ev[0]!.ts).toBe(Date.parse('2026-10-07T16:27:00Z'));
    expect(ev.at(-1)!.ts).toBeNull();
  });

  it('drops terminal escape sequences from words and tool arguments', () => {
    const evil = rec({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'hi \u001b[2J\u001b]0;pwned\u0007there\u009b31m' },
          { type: 'tool_use', name: 'Bash', input: { command: 'ls\u001b[31m /tmp' } },
        ],
      },
    });
    // eslint-disable-next-line no-control-regex
    for (const e of watchEvents([evil])) expect(e.line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it('a half-written last line is skipped, not fatal', () => {
    expect(() => watchEvents(['{"type":"assistant","mess'])).not.toThrow();
    expect(watchEvents(['{"type":"assistant","mess'])).toEqual([]);
  });
});

describe('endedCleanly (ADR 546)', () => {
  it('is true when the last assistant record stopped on end_turn', () => {
    expect(endedCleanly(lines)).toBe(true);
    expect(endedCleanly(lines.slice(0, 3))).toBe(false); // ended on a tool call
    expect(endedCleanly([])).toBe(false);
  });
});

describe('claudeReader (ADR 546)', () => {
  const wake = {
    lease_id: 'L1',
    pid: 77,
    session_id: 'S-1',
    harness: 'claude-code',
    started_at: 1,
    workspace: '/w',
  };
  it('finds the transcript by session id and snapshots events + whether it ended cleanly', () => {
    const r = claudeReader({ transcriptPath: () => '/t.jsonl', readLines: () => lines });
    const snap = r.snapshot(wake)!;
    expect(snap.events).toHaveLength(4);
    expect(snap.endedCleanly).toBe(true);
  });
  it('is null with no session id or no transcript, and survives an unreadable file', () => {
    const r = claudeReader({ transcriptPath: () => undefined });
    expect(r.snapshot(wake)).toBeNull();
    expect(r.snapshot({ ...wake, session_id: null })).toBeNull();
    const throws = claudeReader({
      transcriptPath: () => '/t',
      readLines: () => {
        throw new Error('gone');
      },
    });
    expect(throws.snapshot(wake)).toEqual({ events: [], endedCleanly: false });
  });
});
