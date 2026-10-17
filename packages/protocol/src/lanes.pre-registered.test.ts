import { describe, expect, it } from 'vitest';
import {
  LanePreRegisteredSchema,
  LaneSchema,
  OpenLaneSchema,
  OpenPreRegisteredSchema,
  PickSchema,
  UpdateLaneSchema,
  preRegisteredRefusal,
  pullEligible,
} from './lanes.js';

const base = {
  id: '01X',
  team: 't',
  project: 'p',
  title: 'ADR 536 14-day read',
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

const declaration = {
  run: 'pnpm next:readout --since 2026-10-06',
  verdict_rule:
    'n ≥ 5 and ranked hit rate above baseline → NOT MET; at or below → MET; else INSUFFICIENT',
  record: 'ADR 536 Consequences + docs/wiki/up-next-relevance.md',
  expected_spend: 0,
};

describe('pre-registered declaration (ADR 645)', () => {
  it('an opener declares the three parts and a spend; the daemon stamps by/at', () => {
    const open = OpenPreRegisteredSchema.parse(declaration);
    const stored = LanePreRegisteredSchema.parse({ ...open, by: 'lazara', at: 2 });
    expect(stored.by).toBe('lazara');
    expect(LaneSchema.parse({ ...base, pre_registered: stored }).pre_registered?.run).toBe(
      declaration.run,
    );
  });

  it('a missing part, a negative spend, or a stamped by/at from the client are refused', () => {
    const { record: _record, ...noRecord } = declaration;
    expect(OpenPreRegisteredSchema.safeParse(noRecord).success).toBe(false);
    expect(OpenPreRegisteredSchema.safeParse({ ...declaration, expected_spend: -1 }).success).toBe(
      false,
    );
    expect(OpenPreRegisteredSchema.safeParse({ ...declaration, run: '' }).success).toBe(false);
    // by/at are the daemon's; an opener sending them is stripped, never trusted.
    const parsed = OpenPreRegisteredSchema.parse({ ...declaration, by: 'nick', at: 1 });
    expect('by' in parsed).toBe(false);
  });

  it('carries no date of its own: the day a read is due is ADR 644 reads_on', () => {
    const parsed = OpenPreRegisteredSchema.parse({ ...declaration, not_before: 1 });
    expect('not_before' in parsed).toBe(false);
  });

  it('rides lane_open, and lane_update may set or withdraw it with null', () => {
    expect(
      OpenLaneSchema.parse({ title: 'x', pre_registered: declaration }).pre_registered?.record,
    ).toBe(declaration.record);
    expect(UpdateLaneSchema.parse({ pre_registered: null }).pre_registered).toBeNull();
    expect(UpdateLaneSchema.parse({ pre_registered: declaration }).pre_registered?.run).toBe(
      declaration.run,
    );
  });

  it('an older daemon that never sends the field still parses', () => {
    expect(LaneSchema.parse(base).pre_registered).toBeUndefined();
    expect(LaneSchema.parse({ ...base, pre_registered: null }).pre_registered).toBeNull();
  });
});

describe('preRegisteredRefusal (ADR 645 §2: the anti-goal is enforced at the declaration)', () => {
  it('allows a plain lane and refuses risk, user-facing and high stakes, naming why', () => {
    expect(preRegisteredRefusal({ risk: [], stakes: 'normal' })).toBeNull();
    expect(preRegisteredRefusal({})).toBeNull();
    expect(preRegisteredRefusal({ risk: ['user-facing'] })).toMatch(/user-facing/);
    expect(preRegisteredRefusal({ risk: ['production'] })).toMatch(/production/);
    expect(preRegisteredRefusal({ stakes: 'high' })).toMatch(/high-stakes/);
  });
});

describe('pullEligible (ADR 645 §3: the lane side of a pull offer)', () => {
  const declared = { ...declaration, by: 'lazara', at: 1 };
  const today = '2026-10-20';
  it('only an open, unowned, declared lane', () => {
    expect(pullEligible({ state: 'open', owner_seat: null, pre_registered: declared }, today)).toBe(
      true,
    );
    expect(pullEligible({ state: 'open', owner_seat: null }, today)).toBe(false);
    expect(pullEligible({ state: 'open', owner_seat: null, pre_registered: null }, today)).toBe(
      false,
    );
    expect(
      pullEligible({ state: 'claimed', owner_seat: 'izzo', pre_registered: declared }, today),
    ).toBe(false);
    expect(
      pullEligible({ state: 'parked', owner_seat: null, pre_registered: declared }, today),
    ).toBe(false);
  });

  it('reads_on gates the machine: waiting before the day, offered on it and after', () => {
    const lane = { state: 'open', owner_seat: null, pre_registered: declared, reads_on: today };
    expect(pullEligible(lane, '2026-10-19')).toBe(false);
    expect(pullEligible(lane, '2026-10-20')).toBe(true);
    expect(pullEligible(lane, '2026-10-21')).toBe(true);
    expect(pullEligible({ ...lane, reads_on: null }, '2026-01-01')).toBe(true);
  });
});

describe('a pull claim (ADR 645 §4: the `pulled` attestation)', () => {
  it('is via pull, never attested, names the announcing service seat and the announcement act', () => {
    const p = PickSchema.parse({
      via: 'pull',
      requested_by: 'host',
      attested: false,
      ask: '01ASK',
      at: 1,
    });
    expect(p.via).toBe('pull');
    expect(UpdateLaneSchema.parse({ owner_seat: 'izzo', pick: p }).pick?.ask).toBe('01ASK');
  });

  it('keeps ADR 624 terminal and live picks exactly as they were', () => {
    expect(
      PickSchema.parse({ via: 'terminal', requested_by: 'nick', attested: false, at: 1 }).via,
    ).toBe('terminal');
    expect(
      PickSchema.safeParse({ via: 'slack', requested_by: 'n', attested: false, at: 1 }).success,
    ).toBe(false);
  });
});
