import { describe, expect, it } from 'vitest';
import { readVerdictPatch } from './lanes.js';

describe('readVerdictPatch (ADR 644)', () => {
  it('sends nothing when absent', () => {
    expect(readVerdictPatch(undefined)).toEqual({});
  });

  it('splits "<outcome>: <note>" into the patch field', () => {
    expect(readVerdictPatch('met: hit rate above baseline')).toEqual({
      read_verdict: { outcome: 'met', note: 'hit rate above baseline' },
    });
    expect(readVerdictPatch('  inconclusive :n was 3, below the floor  ')).toEqual({
      read_verdict: { outcome: 'inconclusive', note: 'n was 3, below the floor' },
    });
  });

  it('keeps colons inside the note', () => {
    expect(readVerdictPatch('missed: p95: 74 ms > 70 ms').read_verdict?.note).toBe(
      'p95: 74 ms > 70 ms',
    );
  });

  it('refuses a missing note, an unknown outcome, or no outcome, naming the shape', () => {
    for (const bad of ['met', 'met:', 'later: x', 'just a note'])
      expect(() => readVerdictPatch(bad)).toThrow(/<met\|missed\|inconclusive>: <what was read>/);
  });
});
