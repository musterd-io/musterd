import type { AppMember, AppMoment } from '@musterd/protocol/app-channel';
import { describe, expect, it } from 'vitest';
import { FLOOR_MAX, glowQueue, landedToday, momentWords, newLandings, officeLayout } from './floor';

/** The live floor at the top of Now (ADR 819, the alive design): pure rules, so each has a case. */

const member = (over: Partial<AppMember> & { name: string }): AppMember => ({
  kind: 'agent',
  state: 'working',
  label: 'working on',
  title: 'For you rows show the asker’s portrait',
  source: 'lane',
  goal: null,
  since: 1,
  more_lanes: 0,
  model: 'opus 5.5',
  online: true,
  wakeable: true,
  lane: null,
  portrait: null,
  ...over,
});

const landed = (id: string, member = 'cider', ts = 1): AppMoment => ({
  id,
  kind: 'landed',
  member,
  lane: { id, title: `lane ${id}` },
  goal: null,
  text: null,
  accepted: true,
  ts,
});

describe('newLandings: celebrate only what you were here for', () => {
  it('celebrates nothing on the first load', () => {
    expect(newLandings(null, [landed('a')])).toEqual([]);
  });

  it('celebrates the landings and goals the last pull did not have, oldest first', () => {
    const prev = [landed('a', 'cider', 1)];
    const goal: AppMoment = { ...landed('g', 'wallow', 3), kind: 'goal', lane: null };
    const said: AppMoment = { ...landed('s', 'nick', 4), kind: 'said', lane: null };
    const next = [said, goal, landed('b', 'izzo', 2), ...prev];
    expect(newLandings(prev, next).map((m) => m.id)).toEqual(['b', 'g']);
  });
});

describe('glowQueue: one glow at a time', () => {
  it('queues a burst in order, one per landing, folding a member’s back-to-back ones', () => {
    const burst = [
      landed('1', 'cider'),
      landed('2', 'cider'),
      landed('3', 'izzo'),
      landed('4', 'wallow'),
      landed('5', 'izzo'),
    ];
    expect(glowQueue(burst)).toEqual(['cider', 'izzo', 'wallow', 'izzo']);
  });
});

describe('momentWords: what a moment row says', () => {
  it('leads a landing with the lane and marks it accepted', () => {
    expect(momentWords(landed('a', 'cider'))).toEqual({
      lead: 'cider landed',
      line: 'lane a',
      full: true,
      accepted: true,
    });
    expect(momentWords({ ...landed('b'), accepted: false }).accepted).toBe(false);
  });

  it('rings a goal with its name and the outcome', () => {
    const goal: AppMoment = {
      ...landed('g', 'wallow'),
      kind: 'goal',
      lane: null,
      goal: 'phone-pairing-ux',
      text: 'nick answers from his phone',
    };
    expect(momentWords(goal)).toEqual({
      lead: 'wallow finished phone-pairing-ux',
      line: 'nick answers from his phone',
      full: true,
      accepted: false,
    });
  });

  it('says the quiet ones in one line', () => {
    const base = { ...landed('x', 'big-body'), accepted: undefined };
    expect(momentWords({ ...base, kind: 'started' })).toMatchObject({
      lead: 'big-body started',
      line: 'lane x',
      full: false,
    });
    expect(
      momentWords({ ...base, kind: 'verdict', accepted: true, text: 'Feels right.' }),
    ).toMatchObject({
      lead: 'big-body accepted your lane',
      line: 'lane x',
      full: false,
    });
    expect(momentWords({ ...base, kind: 'verdict', accepted: false })).toMatchObject({
      lead: 'big-body sent back your lane',
    });
    expect(
      momentWords({ ...base, kind: 'said', member: 'nick', lane: null, text: 'lunch at 1' }),
    ).toMatchObject({ lead: 'nick', line: 'lunch at 1', full: false });
  });
});

describe('officeLayout: the floor as /live’s office lays it out', () => {
  it('seats everyone with work at desks, most recent first, at most eight, and sends the rest to the lounge', () => {
    const present = [
      member({ name: 'lounger', state: 'between', since: null, title: null, source: null }),
      ...Array.from({ length: 10 }, (_, i) => member({ name: `w${i}`, since: i })),
    ];
    const { desks, moreDesks, lounge } = officeLayout(present, new Set());
    expect(FLOOR_MAX).toBe(8);
    expect(desks.map((d) => d.member.name)).toEqual([
      'w9',
      'w8',
      'w7',
      'w6',
      'w5',
      'w4',
      'w3',
      'w2',
    ]);
    expect(moreDesks).toBe(2);
    expect(lounge.map((m) => m.name)).toEqual(['lounger']);
  });

  it('says on each desk what its member is on, cut short', () => {
    const [d] = officeLayout([member({ name: 'a', title: 'x'.repeat(40) })], new Set()).desks;
    expect(d).toMatchObject({ cue: `${'x'.repeat(23)}…`, prop: null });
  });

  it('puts the state on the desk as /live does: review, blocked, asking, asking you', () => {
    const layout = officeLayout(
      [
        member({ name: 'r', state: 'review', since: 4 }),
        member({ name: 'b', state: 'blocked', since: 3 }),
        member({ name: 'q', state: 'asking', label: 'asking nick', since: 2 }),
        member({ name: 'y', state: 'asking', label: 'asking nick', since: 1 }),
      ],
      new Set(['y']),
    );
    expect(layout.desks.map((d) => [d.member.name, d.prop])).toEqual([
      ['r', 'review'],
      ['b', 'blocked'],
      ['q', 'asking'],
      ['y', 'asking-you'],
    ]);
  });

  it('is an empty room when nobody is here', () => {
    expect(officeLayout([], new Set())).toEqual({ desks: [], moreDesks: 0, lounge: [] });
  });
});

describe('landedToday: the board’s count', () => {
  it('counts the day’s landings', () => {
    const goal: AppMoment = { ...landed('g'), kind: 'goal', lane: null };
    expect(landedToday([landed('a'), landed('b'), goal])).toBe(2);
  });
});
