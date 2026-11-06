import { describe, expect, it } from 'vitest';
import type { AppForYou, AppMember } from './team';
import { forYouCount, headerLines, modelLine, portraitOf, sinceLabel, teamRows } from './team';

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
  it('headerLines names the team, who is here and away, and what needs you', () => {
    expect(
      headerLines({
        pairing: 'paired',
        team: 'revive',
        counts: { here: 9, offline: 21, needYou: 1 },
      }),
    ).toEqual({ title: 'revive', sub: '9 here · 21 away', chip: '1 for you' });
    expect(
      headerLines({
        pairing: 'paired',
        team: 'revive',
        counts: { here: 3, offline: 0, needYou: 0 },
      }),
    ).toEqual({ title: 'revive', sub: '3 here', chip: null });
  });

  it('headerLines says where an unpaired phone stands', () => {
    const counts = { here: 0, offline: 0, needYou: 0 };
    expect(headerLines({ pairing: 'waiting', team: 'revive', counts })).toEqual({
      title: 'revive',
      sub: 'Waiting for approval',
      chip: null,
    });
    expect(headerLines({ pairing: 'none', team: null, counts })).toEqual({
      title: 'musterd',
      sub: 'Not paired',
      chip: null,
    });
  });

  it('sinceLabel is /live’s elapsed(): <1m, 42m, 3h, 2d, and null for none', () => {
    expect(sinceLabel(NOW - 10_000, NOW)).toBe('<1m');
    expect(sinceLabel(NOW - 42 * 60_000, NOW)).toBe('42m');
    expect(sinceLabel(NOW - 3 * 3_600_000, NOW)).toBe('3h');
    expect(sinceLabel(NOW - 2 * 86_400_000, NOW)).toBe('2d');
    expect(sinceLabel(null, NOW)).toBeNull();
  });
});

describe('build 59 fixes (nick’s screenshots, 2026-11-06)', () => {
  it('the For you header counts the merged list, not the phone’s own asks', () => {
    const r = roster({
      members: [],
      for_you: [
        { id: 'a', from: 'miley', kind: 'approve', summary: 'a', ts: 1 },
        { id: 'b', from: 'fifty', kind: 'question', summary: 'b', ts: 2 },
      ],
    });
    const rows = teamRows(r, [{ id: 'b', from: 'fifty', ts: 2, summary: 'b' }], 'nick');
    expect(forYouCount(rows)).toBe(2);
  });

  it('an away row shows no model line; a present one keeps /live’s badge, unknown included', () => {
    expect(modelLine(member({ name: 'alfie', state: 'away', model: 'model unknown' }))).toBeNull();
    expect(modelLine(member({ name: 'dolly', state: 'away', model: 'opus 5.5' }))).toBeNull();
    expect(modelLine(member({ name: 'cider', model: 'opus 5.5' }))).toBe('opus 5.5');
    expect(modelLine(member({ name: 'x', model: 'model unknown' }))).toBe('model unknown');
  });
});

describe('For you shows faces (nick, 2026-11-06)', () => {
  it('finds the asker’s portrait among the members, present or away; none for a stranger', () => {
    const r = roster({
      members: [
        member({ name: 'miley', portrait: 'aaaaaaaaaaaaaaaa' }),
        member({ name: 'dolly', state: 'away', portrait: 'bbbbbbbbbbbbbbbb' }),
      ],
    });
    const rows = teamRows(r, [], 'nick');
    expect(portraitOf(rows, 'miley')).toBe('aaaaaaaaaaaaaaaa');
    expect(portraitOf(rows, 'dolly')).toBe('bbbbbbbbbbbbbbbb');
    expect(portraitOf(rows, 'live')).toBeNull();
  });
});
