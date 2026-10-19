import { describe, expect, it } from 'vitest';
import { LaneBoardSchema, LaneWarningSchema, LaneWarningsSchema } from './lanes.js';

const stalled = {
  kind: 'stalled_continuation',
  subject: '01L',
  with: '01L',
  owner: null,
  detail: 'no wake due',
};

describe('lane warnings (ADR 664)', () => {
  it('stalled_continuation is a warning kind', () => {
    expect(LaneWarningSchema.parse(stalled).kind).toBe('stalled_continuation');
  });

  it('a warnings array drops a kind this build cannot read and keeps the rest', () => {
    const later = { ...stalled, kind: 'a_kind_from_a_later_epoch' };
    expect(LaneWarningsSchema.parse([later, stalled])).toEqual([stalled]);
  });

  it('a board with an unreadable warning still parses', () => {
    const board = LaneBoardSchema.safeParse({
      lanes: [],
      warnings: [
        { kind: 'a_kind_from_a_later_epoch', subject: 'x', with: 'x', owner: null, detail: '' },
      ],
    });
    expect(board.success).toBe(true);
    expect(board.data?.warnings).toEqual([]);
  });
});
