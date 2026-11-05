import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRIEF_MAX_BYTES,
  briefBudgetBytes,
  compactTranscript,
  composeContinuationLine,
  fitBrief,
} from './continuationBrief.js';

const rec = (type: string, content: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, message: { role: type, content }, ...extra });

function transcript(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'brief-'));
  const p = join(dir, 's.jsonl');
  writeFileSync(p, `${lines.join('\n')}\n`);
  return p;
}

describe('ADR 810: the continuation brief', () => {
  it('keeps the seat’s text and tool calls and the person’s prompts; drops thinking, results, mirrors', () => {
    const p = transcript([
      rec('user', 'Implement token chunking for long documents. Coordinate with agent2.'),
      rec('assistant', [
        { type: 'thinking', thinking: 'secret plans', signature: 'x' },
        { type: 'text', text: 'I will claim a lane first.' },
        { type: 'tool_use', id: 't1', name: 'mcp__musterd__lane_claim', input: { id: '01ABC' } },
      ]),
      rec('user', [{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(5000) }]),
      JSON.stringify({ type: 'api-request-blob', content: [{ type: 'text', text: 'mirror' }] }),
      JSON.stringify({ type: 'attachment', content: 'big' }),
      rec('assistant', [{ type: 'text', text: 'Patch written to chunk.py; ending my turn.' }]),
      'not json at all',
    ]);
    const brief = compactTranscript(p, BRIEF_MAX_BYTES)!;
    expect(brief.turns).toBe(4);
    expect(brief.dropped).toBe(0);
    expect(brief.text).toContain('> Implement token chunking');
    expect(brief.text).toContain('I will claim a lane first.');
    expect(brief.text).toContain('[mcp__musterd__lane_claim] {"id":"01ABC"}');
    expect(brief.text).toContain('Patch written to chunk.py');
    expect(brief.text).not.toContain('secret plans');
    expect(brief.text).not.toContain('xxxxx');
    expect(brief.text).not.toContain('mirror');
    expect(brief.text).toMatch(/^--- Continuation brief \(ADR 810\) ---/);
  });

  it('trims from the oldest end to fit the budget, and says how many turns went', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `turn ${i} ${'·'.repeat(40)}`);
    const full = fitBrief(lines, 100_000, BRIEF_MAX_BYTES)!;
    expect(full.turns).toBe(50);
    const small = fitBrief(lines, 100_000, 1_200)!;
    expect(small.turns).toBeLessThan(50);
    expect(small.dropped).toBe(50 - small.turns);
    expect(small.text).toContain(`(${small.dropped} earlier turns dropped)`);
    expect(small.text).toContain('turn 49');
    expect(small.text).not.toContain('turn 0 ');
    expect(Buffer.byteLength(small.text, 'utf8')).toBeLessThanOrEqual(1_200);
    // A budget that holds not one turn yields no brief: the fresh spawn is always valid.
    expect(fitBrief(lines, 100_000, 10)).toBeUndefined();
  });

  it('never carries a credential, and clips long turns', () => {
    const p = transcript([
      rec('assistant', [
        {
          type: 'text',
          text: `use mskey_abcDEF123 and token: hunter2 then ${'long '.repeat(300)}`,
        },
        {
          type: 'tool_use',
          id: 't',
          name: 'Bash',
          input: { command: 'curl -H "Authorization: Bearer sk-ant-abcdefghij"' },
        },
      ]),
    ]);
    const brief = compactTranscript(p, BRIEF_MAX_BYTES)!;
    expect(brief.text).not.toContain('mskey_abc');
    expect(brief.text).not.toContain('hunter2');
    expect(brief.text).not.toContain('sk-ant-abcdefghij');
    expect(brief.text).toContain('[redacted]');
    const longest = Math.max(...brief.text.split('\n').map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(600);
  });

  it('an unreadable or turnless transcript yields no brief', () => {
    expect(compactTranscript('/no/such/file.jsonl', BRIEF_MAX_BYTES)).toBeUndefined();
    const p = transcript([JSON.stringify({ type: 'cost-state', x: 1 })]);
    expect(compactTranscript(p, BRIEF_MAX_BYTES)).toBeUndefined();
  });

  it('the budget is what the bound buys at the model’s input rate, capped; unpriced is none', () => {
    // claude-sonnet-5-5: $2/MTok input → $0.25 buys 125k tokens = 500 KB, capped at 48 KiB.
    expect(briefBudgetBytes(0.25, 'claude-sonnet-5-5')).toBe(BRIEF_MAX_BYTES);
    // $0.001 buys 500 tokens = 2,000 bytes.
    expect(briefBudgetBytes(0.001, 'claude-sonnet-5-5')).toBe(2_000);
    expect(briefBudgetBytes(0.25, 'no-such-model')).toBeUndefined();
    expect(briefBudgetBytes(0.25, undefined)).toBeUndefined();
  });

  it('the wake line leads the composed prompt; the brief follows', () => {
    const brief = fitBrief(['did a thing'], 10, 1_000)!;
    const line = composeContinuationLine('musterd wake — …', brief);
    expect(line.startsWith('musterd wake — …\n\n--- Continuation brief')).toBe(true);
    expect(line.endsWith('did a thing')).toBe(true);
  });
});
