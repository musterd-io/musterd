import { describe, expect, it } from 'vitest';
import type { AppForYou, AppMember } from './team';
import { sinceLabel, summaryLine, teamRows } from './team';

const NOW = 1_800_000_000_000;

const member = (over: Partial<AppMember> & { name: string }): AppMember => ({
  kind: 'agent',
  state: 'working',
  label: 'working on',
  title: 'a lane',
  source: 'lane',
  goal: null,
  since: NOW - 60_000,
  more_lanes: 0,
  model: 'opus 5.5',
  online: true,
  wakeable: true,
  lane: { id: 'L1', title: 'a lane' },
  portrait: null,
  ...over,
});

const roster = (over: Record<string, unknown>) =>
  ({
    v: 1,
    kind: 'roster',
    team: 'revive',
    binding: 'b1',
    ts: NOW,
    seats: [],
    ...over,
  }) as Parameters<typeof teamRows>[0];

describe('teamRows (ADR 814): the Now screen from the roster', () => {
  it('keeps the daemon’s order for present members and folds away the away ones', () => {
    const r = roster({
      members: [
        member({ name: 'izzo', state: 'away', label: 'away', online: false }),
        member({ name: 'nick', kind: 'human', model: 'human' }),
        member({ name: 'lazara' }),
      ],
    });
    const rows = teamRows(r, [], 'nick');
    expect(rows.present.map((m) => m.name)).toEqual(['nick', 'lazara']);
    expect(rows.offline.map((m) => m.name)).toEqual(['izzo']);
    expect(rows.counts).toEqual({ here: 2, offline: 1, needYou: 0 });
  });

  it('falls back to seats from a daemon that sends no members (ADR 791 phones and daemons)', () => {
    const r = roster({
      seats: [
        { seat: 'cider', online: true, wakeable: true, lane: { id: 'L1', title: 'phone' } },
        { seat: 'fifty', online: false, wakeable: true, lane: null },
      ],
    });
    const rows = teamRows(r, [], null);
    expect(rows.present).toHaveLength(1);
    expect(rows.present[0]).toMatchObject({
      name: 'cider',
      state: 'working',
      label: 'working on',
      title: 'phone',
      model: null,
    });
    expect(rows.offline[0]).toMatchObject({ name: 'fifty', state: 'away', wakeable: true });
    expect(rows.counts.here).toBe(1);
  });

  it('unions for_you with the phone’s own asks by id, oldest first', () => {
    const fy = (id: string, ts: number): AppForYou => ({
      id,
      from: 'miley',
      kind: 'approve',
      summary: `ask ${id}`,
      ts,
    });
    const r = roster({ members: [], for_you: [fy('a', NOW - 3000), fy('b', NOW - 2000)] });
    const own = [
      { id: 'b', from: 'miley', ts: NOW - 2000, summary: 'ask b' },
      { id: 'c', from: 'fifty', ts: NOW - 1000, summary: 'ask c' },
    ];
    const rows = teamRows(r, own, 'nick');
    expect(rows.forYou.map((f) => f.id)).toEqual(['a', 'b', 'c']);
    expect(rows.counts.needYou).toBe(3);
  });

  it('orders offline members wakeable agents, other agents, then people', () => {
    const r = roster({
      members: [
        member({ name: 'dolly', kind: 'human', state: 'away', online: false, wakeable: false }),
        member({ name: 'ryder', state: 'away', online: false, wakeable: true }),
        member({ name: 'alfie', state: 'away', online: false, wakeable: false }),
      ],
    });
    expect(teamRows(r, [], null).offline.map((m) => m.name)).toEqual(['ryder', 'alfie', 'dolly']);
  });
});

describe('the Now header', () => {
  it('summaryLine says here · offline · need you, dropping zero parts but here', () => {
    expect(summaryLine({ here: 10, offline: 20, needYou: 2 })).toBe(
      '10 here · 20 offline · 2 need you',
    );
    expect(summaryLine({ here: 3, offline: 0, needYou: 0 })).toBe('3 here');
    expect(summaryLine({ here: 0, offline: 0, needYou: 1 })).toBe('0 here · 1 needs you');
  });

  it('sinceLabel is /live’s elapsed(): <1m, 42m, 3h, 2d, and null for none', () => {
    expect(sinceLabel(NOW - 10_000, NOW)).toBe('<1m');
    expect(sinceLabel(NOW - 42 * 60_000, NOW)).toBe('42m');
    expect(sinceLabel(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(sinceLabel(NOW - 2 * 86_400_000, NOW)).toBe('2d');
    expect(sinceLabel(null, NOW)).toBeNull();
  });
});
