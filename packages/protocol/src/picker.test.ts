import { describe, expect, it } from 'vitest';
import type { Lane, LaneWarning } from './lanes.js';
import { filterPicker, pickerRows } from './picker.js';

const lane = (o: Partial<Lane>): Lane =>
  ({
    id: '01AAAAAAAAAAAAAAAAAAAAAAAA',
    team: 't',
    project: 'p',
    title: 't',
    detail: null,
    owner_seat: null,
    role: null,
    scope: [],
    areas: [],
    depends_on: [],
    branch: null,
    goal_id: null,
    risk: [],
    stakes: 'normal',
    stakes_provenance: 'declared',
    merged: null,
    state: 'open',
    created_by: 'nick',
    created_at: 0,
    claimed_at: null,
    resolved_at: null,
    updated_at: 0,
    ...o,
  }) as Lane;

const unmet = (subject: string, on: string): LaneWarning => ({
  kind: 'unmet_dependency',
  subject,
  with: on,
  owner: 'dolly',
  detail: 'building on "dep" (owner dolly), still active',
});

describe('pickerRows (ADR 624)', () => {
  it('keeps only open unowned lanes, groups by goal with goalless last, oldest first', () => {
    const v = pickerRows(
      {
        lanes: [
          lane({ id: '01B0000000000000000000000B', goal_id: 'cloud', created_at: 20 }),
          lane({ id: '01B0000000000000000000000A', goal_id: 'cloud', created_at: 10 }),
          lane({ id: '01C0000000000000000000000C', goal_id: null }),
          lane({ id: '01D0000000000000000000000D', goal_id: 'alpha' }),
          lane({ id: '01E0000000000000000000000E', state: 'claimed', owner_seat: 'x' }),
          lane({ id: '01F0000000000000000000000F', state: 'parked' }),
          lane({ id: '01G0000000000000000000000G', state: 'done' }),
        ],
        warnings: [],
      },
      'izzo',
      100,
    );
    expect(v.claimable.map((g) => g.goal)).toEqual(['alpha', 'cloud', null]);
    const cloud = v.claimable[1]!.rows;
    expect(cloud.map((r) => r.id)).toEqual([
      '01B0000000000000000000000A',
      '01B0000000000000000000000B',
    ]);
    expect(cloud[0]!.short).toBe('01B0000000');
    expect(cloud[0]!.age_ms).toBe(90);
    expect(v.blocked).toEqual([]);
  });

  it('reads blocked ONLY from unmet_dependency warnings: a depends_on the board omits is met', () => {
    const v = pickerRows(
      {
        lanes: [
          lane({ id: '01H000000000000000000000H1', depends_on: ['01OLD00000000000000000000X'] }),
          lane({ id: '01H000000000000000000000H2', depends_on: ['01DEP00000000000000000000Y'] }),
        ],
        warnings: [
          unmet('01H000000000000000000000H2', '01DEP00000000000000000000Y'),
          { ...unmet('01H000000000000000000000H1', 'x'), kind: 'surface_overlap' },
        ],
      },
      'izzo',
      0,
    );
    expect(v.claimable.flatMap((g) => g.rows).map((r) => r.id)).toEqual([
      '01H000000000000000000000H1',
    ]);
    expect(v.blocked[0]!.rows[0]!.blocked_on).toEqual([
      {
        lane: '01DEP00000000000000000000Y',
        owner: 'dolly',
        detail: 'building on "dep" (owner dolly), still active',
      },
    ]);
  });

  it('lists what the seat is carrying, and carries the decline note', () => {
    const v = pickerRows(
      {
        lanes: [
          lane({ id: '01J000000000000000000000J1', state: 'active', owner_seat: 'izzo' }),
          lane({
            id: '01J000000000000000000000J2',
            state: 'awaiting_acceptance',
            owner_seat: 'izzo',
          }),
          lane({
            id: '01J000000000000000000000J3',
            declined: { by: 'izzo', reason: 'needs a second machine', at: 5 },
          }),
        ],
        warnings: [],
      },
      'izzo',
      0,
    );
    expect(v.carrying).toEqual(['01J0000000']);
    expect(v.claimable[0]!.rows[0]!.declined?.reason).toBe('needs a second machine');
  });
});

describe('filterPicker (ADR 624)', () => {
  const v = pickerRows(
    {
      lanes: [
        lane({
          id: '01K000000000000000000000K1',
          title: 'Cloud duplicate envelope id',
          goal_id: 'cloud',
          areas: ['server'],
        }),
        lane({ id: '01K000000000000000000000K2', title: 'stream ensure stall', goal_id: 'launch' }),
      ],
      warnings: [],
    },
    'izzo',
    0,
  );

  it('every word must match id, title, goal or areas, case-insensitively', () => {
    expect(
      filterPicker(v, 'SERVER dup')
        .claimable.flatMap((g) => g.rows)
        .map((r) => r.id),
    ).toEqual(['01K000000000000000000000K1']);
  });

  it('drops groups left empty, and blank text changes nothing', () => {
    expect(filterPicker(v, '01k000000000000000000000k2').claimable.map((g) => g.goal)).toEqual([
      'launch',
    ]);
    expect(filterPicker(v, 'nothing-matches').claimable).toEqual([]);
    expect(filterPicker(v, '   ')).toBe(v);
  });
});
