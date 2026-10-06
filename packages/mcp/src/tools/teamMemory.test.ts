import { describe, expect, it } from 'vitest';
import { insightStatusLines } from './teamMemory.js';

describe('team_insight_search status lines (ADR 526)', () => {
  it('says nothing for a finding that stands', () => {
    expect(insightStatusLines(undefined)).toBe('');
  });
  it('names who replaced it, so a reader goes to the replacement, not the original', () => {
    expect(
      insightStatusLines({
        superseded_by: [{ id: 'I2', from: 'ghost', headline: 'fixed by #2066', hides: false }],
      }),
    ).toBe("\n  ⚠ superseded by ghost's [I2] fixed by #2066");
  });
  it('a retraction under all=1 reads as one', () => {
    expect(insightStatusLines({ retracted: { by: 'miley', at: 1, reason: 'fixed' } })).toBe(
      '\n  ⚠ retracted by miley: fixed',
    );
  });
});
