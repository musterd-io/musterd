import { describe, expect, it } from 'vitest';
import { LaneSchema, UpdateLaneSchema, MERGE_VERIFICATION_TIERS, laneLanded } from './lanes.js';

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
  state: 'claimed',
  created_by: 'izzo',
  created_at: 1,
  claimed_at: null,
  resolved_at: null,
  updated_at: 1,
};

describe('merged.verification (merge-verified submit)', () => {
  it('round-trips a known tier', () => {
    const lane = LaneSchema.parse({
      ...base,
      merged: { sha: 'abc123f', verification: 'ancestor' },
    });
    expect(lane.merged?.verification).toBe('ancestor');
  });

  it('parses with the field absent (older client)', () => {
    const lane = LaneSchema.parse({ ...base, merged: { sha: 'abc123f' } });
    expect(lane.merged?.verification).toBeUndefined();
  });

  it('accepts an unknown tier from a newer client rather than rejecting', () => {
    const lane = LaneSchema.parse({ ...base, merged: { verification: 'quantum_entangled' } });
    expect(lane.merged?.verification).toBe('quantum_entangled');
  });

  it('UpdateLane carries it through', () => {
    const patch = UpdateLaneSchema.parse({
      merged: { pr: 7, sha: 'abc123f', verification: 'unattested' },
    });
    expect(patch.merged?.verification).toBe('unattested');
  });

  it('exports the tier list for renderers', () => {
    expect(MERGE_VERIFICATION_TIERS).toEqual([
      'ancestor',
      'unknown_object',
      'fetch_failed',
      'unattested',
    ]);
  });
});

// lane 01M5G8VTK0: the surfaces gate the "clear the local branch … -D" hint on this.
describe('laneLanded', () => {
  it('is true on an ancestor-verified attestation', () => {
    expect(laneLanded({ merged: { verification: 'ancestor' } })).toBe(true);
  });
  it('is true on a confirmed commit_landed claim (the CLI rail stamps no tier)', () => {
    expect(
      laneLanded({ merged: null, claims: [{ kind: 'commit_landed', verdict: 'confirmed' }] }),
    ).toBe(true);
  });
  it('is false with no attestation, an abstained tier, or an unconfirmed claim', () => {
    expect(laneLanded({})).toBe(false);
    expect(laneLanded({ merged: null })).toBe(false);
    expect(laneLanded({ merged: { verification: 'unknown_object' } })).toBe(false);
    expect(laneLanded({ merged: { verification: 'unattested' } })).toBe(false);
    expect(laneLanded({ claims: [{ kind: 'commit_landed', verdict: 'unverifiable' }] })).toBe(
      false,
    );
    expect(laneLanded({ claims: [{ kind: 'pr_merged', verdict: 'confirmed' }] })).toBe(false);
  });
});
