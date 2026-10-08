import { describe, expect, it } from 'vitest';
import { endedCleanly, formatWatchLine, watchEvents } from './events.js';

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

describe('watchEvents (ADR 546)', () => {
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

describe('formatWatchLine (ADR 546)', () => {
  it('is one row, trimmed to the width', () => {
    const row = formatWatchLine({ ts: null, kind: 'text', line: 'x'.repeat(200) }, 40);
    expect([...row].length).toBeLessThanOrEqual(40);
    expect(row.endsWith('…')).toBe(true);
  });
  it('prefixes the time when it is known, and leaves a short line alone', () => {
    const ts = new Date(2026, 9, 7, 9, 5).getTime();
    expect(formatWatchLine({ ts, kind: 'tool', line: '▸ Bash  ls' }, 80)).toBe('09:05  ▸ Bash  ls');
    expect(formatWatchLine({ ts: null, kind: 'tool', line: '▸ Bash  ls' }, 80)).toBe('▸ Bash  ls');
  });
});
