import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  BRIEF_MAX_BYTES,
  briefBudgetBytes,
  compactTranscript,
  composeContinuationLine,
  constrainedValue,
  fitBrief,
  redact,
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
        {
          type: 'tool_use',
          id: 't1',
          name: 'mcp__musterd__lane_claim',
          input: { id: '01M6PA2PWX3AX432EJQCG62945' },
        },
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
    expect(brief.text).toContain('[mcp__musterd__lane_claim] id');
    expect(brief.text).not.toContain('01M6PA2PWX3AX432EJQCG62945');
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
    expect(brief.text).not.toContain('curl');
    expect(brief.text).toContain('[Bash] command');
    expect(brief.text).toContain('[redacted]');
    const longest = Math.max(...brief.text.split('\n').map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(600);
  });

  it('a value rides only from a closed set the product owns, or as an integer — never by shape', () => {
    expect(constrainedValue('act', 'message')).toBe('message');
    expect(constrainedValue('act', 'hunter2')).toBeUndefined();
    expect(constrainedValue('state', 'active')).toBe('active');
    expect(constrainedValue('offset', 10)).toBe('10');
    expect(constrainedValue('offset', '10')).toBeUndefined();
    // Shapes are not grammars (big-body's third read): a path with a slash, a Crockford id, a glob.
    expect(constrainedValue('file_path', '/ws/src/a.ts')).toBeUndefined();
    expect(constrainedValue('path', 'hunter2/secret')).toBeUndefined();
    expect(constrainedValue('id', '01M6PA2PWX3AX432EJQCG62945')).toBeUndefined();
    expect(constrainedValue('id', 'AKIAIOSFODNN7EXAMPLE')).toBeUndefined();
    for (const key of [
      'pattern',
      'glob',
      'name',
      'to',
      'seat',
      'lane',
      'goal_id',
      'command',
      'body',
    ]) {
      expect(constrainedValue(key, 'message')).toBeUndefined();
    }
  });

  it("tool arguments ride by construction: closed-set values only, every other key is a name (big-body's reads)", () => {
    const p = transcript([
      rec('assistant', [
        {
          type: 'tool_use',
          id: 'a',
          name: 'Write',
          input: { file_path: '/ws/.env', content: 'DB_PASSWORD=example-value' },
        },
        {
          type: 'tool_use',
          id: 'b',
          name: 'mcp__x__login',
          input: { password: 'example-value', user: 'nick' },
        },
        {
          type: 'tool_use',
          id: 'c',
          name: 'Bash',
          input: { command: 'export API_KEY=AKIAIOSFODNN7EXAMPLEKEY1234 && deploy' },
        },
        {
          type: 'tool_use',
          id: 'd',
          name: 'Read',
          input: { file_path: '/ws/src/a.ts', offset: 10, limit: 40 },
        },
        {
          type: 'tool_use',
          id: 'e',
          name: 'mcp__musterd__team_send',
          input: { act: 'message', to: 'agent2', body: 'the token is hunter2' },
        },
        {
          type: 'tool_use',
          id: 'f',
          name: 'Grep',
          input: { pattern: 'hunter2', path: 'hunter2/secret', glob: 'hunter2' },
        },
        {
          type: 'tool_use',
          id: 'g',
          name: 'mcp__musterd__lane_claim',
          input: { id: 'AKIAIOSFODNN7EXAMPLE' },
        },
        {
          type: 'tool_use',
          id: 'h',
          name: 'mcp__musterd__lane_update',
          input: { id: '01M6PA2PWX', state: 'active' },
        },
      ]),
    ]);
    const brief = compactTranscript(p, BRIEF_MAX_BYTES)!;
    expect(brief.text).toContain('[Write] file_path content');
    expect(brief.text).toContain('[mcp__x__login] password user');
    expect(brief.text).toContain('[Bash] command');
    expect(brief.text).toContain('[Read] file_path offset=10 limit=40');
    expect(brief.text).toContain('[mcp__musterd__team_send] act=message to body');
    expect(brief.text).toContain('[Grep] pattern path glob');
    expect(brief.text).toContain('[mcp__musterd__lane_claim] id');
    expect(brief.text).toContain('[mcp__musterd__lane_update] id state=active');
    for (const leak of [
      'example-value',
      'AKIAIOSFODNN7',
      'hunter2',
      'nick',
      'deploy',
      'agent2',
      '/ws/',
      '01M6PA2PWX',
    ]) {
      expect(brief.text).not.toContain(leak);
    }
  });

  it('prose patterns tolerate JSON quoting, bearer headers and long opaque tokens, before clipping', () => {
    expect(redact('{"password":"example-value"}')).toBe('{"[redacted]"}');
    expect(redact('api_key = "abc"')).toBe('[redacted]"');
    // The key pattern takes the whole header (authorization is a credential key); either layer does.
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abc')).toBe('[redacted]');
    expect(redact('sent Bearer eyJhbGciOiJIUzI1NiJ9.abc along')).toBe('sent [redacted] along');
    expect(
      redact('the hash is 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 ok'),
    ).toBe('the hash is [redacted] ok');
    expect(redact('a normal sentence with words and the number 2026-11-05 in it')).toBe(
      'a normal sentence with words and the number 2026-11-05 in it',
    );
    // Redaction runs on the whole text, so a clip cannot split a secret out of a pattern's reach.
    const p = transcript([rec('user', `${'x '.repeat(195)}password: example-value and more`)]);
    const brief = compactTranscript(p, BRIEF_MAX_BYTES)!;
    expect(brief.text).not.toContain('example-value');
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
