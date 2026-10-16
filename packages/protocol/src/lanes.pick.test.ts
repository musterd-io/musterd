import { describe, expect, it } from 'vitest';
import { LaneSchema, PickSchema, UpdateLaneSchema } from './lanes.js';

const base = {
  id: '01X',
  team: 't',
  project: 'p',
  title: 'x',
  detail: '',
  owner_seat: null,
  role: null,
  scope: [],
  depends_on: [],
  branch: null,
  goal_id: null,
  risk: [],
  stakes: 'normal',
  state: 'open',
  created_by: 'nick',
  created_at: 1,
  claimed_at: null,
  resolved_at: null,
  updated_at: 1,
};

describe('lane picker schemas (ADR 624)', () => {
  it('a terminal pick parses and keeps its honest label on the claim patch', () => {
    const p = PickSchema.parse({
      via: 'terminal',
      requested_by: 'nick',
      attested: false,
      harness: 'claude-code',
      at: 1,
    });
    expect(p.attested).toBe(false);
    expect(UpdateLaneSchema.parse({ owner_seat: 'izzo', pick: p }).pick).toEqual(p);
  });

  it('refuses an unknown via, an empty requester, and an over-long release reason', () => {
    expect(
      PickSchema.safeParse({ via: 'slack', requested_by: 'n', attested: false, at: 1 }).success,
    ).toBe(false);
    expect(
      PickSchema.safeParse({ via: 'live', requested_by: '', attested: true, at: 1 }).success,
    ).toBe(false);
    expect(
      UpdateLaneSchema.safeParse({ state: 'open', release_reason: 'x'.repeat(501) }).success,
    ).toBe(false);
    expect(
      UpdateLaneSchema.parse({ state: 'open', release_reason: 'needs a VM' }).release_reason,
    ).toBe('needs a VM');
  });

  it('a lane without declined still parses (older daemon), and declined round-trips', () => {
    expect(LaneSchema.parse(base).declined ?? null).toBeNull();
    const d = { by: 'izzo', reason: 'needs a second machine', at: 2 };
    expect(LaneSchema.parse({ ...base, declined: d }).declined).toEqual(d);
  });
});
