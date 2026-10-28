import { describe, expect, it } from 'vitest';
import { LaneCardSchema, laneCardColumn, UpdateLaneSchema } from './lanes.js';

describe('lane card (ADR 751)', () => {
  it('holds a place inside the cell, stamped by the server', () => {
    expect(LaneCardSchema.parse({ x: 0, y: 1, by: 'ada', at: 1 })).toEqual({
      x: 0,
      y: 1,
      by: 'ada',
      at: 1,
    });
    expect(LaneCardSchema.safeParse({ x: 1.2, y: 0.5, by: 'ada', at: 1 }).success).toBe(false);
    expect(LaneCardSchema.safeParse({ x: 0.5, y: -0.1, by: 'ada', at: 1 }).success).toBe(false);
  });

  it('lets an update name only x and y', () => {
    expect(UpdateLaneSchema.parse({ card: { x: 0.25, y: 0.7 } }).card).toEqual({ x: 0.25, y: 0.7 });
    expect(UpdateLaneSchema.safeParse({ card: { x: 0.25 } }).success).toBe(false);
  });

  it('maps a state to its board column, off the board for parked and abandoned', () => {
    expect(laneCardColumn('active')).toBe('active');
    expect(laneCardColumn('ready_for_review')).toBe('awaiting_acceptance');
    expect(laneCardColumn('parked')).toBeNull();
    expect(laneCardColumn('abandoned')).toBeNull();
  });
});
