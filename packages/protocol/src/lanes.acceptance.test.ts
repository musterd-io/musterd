import { describe, expect, it } from 'vitest';
import { AcceptanceRouteSchema, LaneSchema } from './lanes.js';

// ADR 518: who an awaiting-acceptance lane waits on, as a never-stored board projection.
const awaiting = {
  id: '01X',
  team: 't',
  project: 'p',
  title: 'x',
  detail: null,
  owner_seat: 'izzo',
  role: null,
  scope: [],
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  stakes: 'normal',
  state: 'awaiting_acceptance',
  created_by: 'izzo',
  created_at: 1,
  claimed_at: 1,
  resolved_at: null,
  updated_at: 1,
};

describe('acceptance_reviewer / acceptance_route (ADR 518)', () => {
  it('round-trips both fields', () => {
    const lane = LaneSchema.parse({
      ...awaiting,
      acceptance_reviewer: 'ghost',
      acceptance_route: 'peer_selected',
    });
    expect(lane.acceptance_reviewer).toBe('ghost');
    expect(lane.acceptance_route).toBe('peer_selected');
  });

  it('stays optional, so an older daemon’s lane still parses', () => {
    const lane = LaneSchema.parse(awaiting);
    expect(lane.acceptance_reviewer).toBeUndefined();
    expect(lane.acceptance_route).toBeUndefined();
  });

  it('refuses a route outside the recorded vocabulary', () => {
    expect(AcceptanceRouteSchema.safeParse('review_timeout').success).toBe(false);
    expect(LaneSchema.safeParse({ ...awaiting, acceptance_route: 'guess' }).success).toBe(false);
  });
});
