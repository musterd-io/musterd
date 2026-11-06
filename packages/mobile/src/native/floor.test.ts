import type { AppMember, AppMoment } from '@musterd/protocol/app-channel';
import { describe, expect, it } from 'vitest';
import {
  BUBBLE_MS,
  FLOOR_MAX,
  bubbleText,
  floorDesks,
  glowQueue,
  momentWords,
  newLandings,
} from './floor';

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

describe('floorDesks: who sits on the floor', () => {
  it('seats at most eight, most recently active first, and counts the rest', () => {
    const present = Array.from({ length: 11 }, (_, i) => member({ name: `m${i}`, since: i }));
    const { desks, more } = floorDesks(present);
    expect(FLOOR_MAX).toBe(8);
    expect(desks.map((d) => d.name)).toEqual(['m10', 'm9', 'm8', 'm7', 'm6', 'm5', 'm4', 'm3']);
    expect(more).toBe(3);
  });

  it('keeps the roster’s order for members with no lane time', () => {
    const { desks } = floorDesks([
      member({ name: 'b', since: null }),
      member({ name: 'a', since: 5 }),
      member({ name: 'c', since: null }),
    ]);
    expect(desks.map((d) => d.name)).toEqual(['a', 'b', 'c']);
  });

  it('is an empty room when nobody is here', () => {
    expect(floorDesks([])).toEqual({ desks: [], more: 0 });
  });
});

describe('bubbleText: one short line over a desk', () => {
  it('says what a working member is on, cut short', () => {
    expect(bubbleText(member({ name: 'a', title: 'x'.repeat(40) }), false)).toEqual({
      text: `${'x'.repeat(27)}…`,
      mine: false,
    });
  });

  it('says asking you, in mustard, only when they are asking you', () => {
    const m = member({ name: 'miley', state: 'asking', label: 'asking nick' });
    expect(bubbleText(m, true)).toEqual({ text: 'asking you →', mine: true });
    expect(bubbleText(m, false)).toEqual({ text: 'asking nick', mine: false });
  });

  it('names review and blocked, and says nothing between tasks or away', () => {
    expect(bubbleText(member({ name: 'a', state: 'review' }), false)?.text).toBe(
      'waiting for review',
    );
    expect(bubbleText(member({ name: 'a', state: 'blocked' }), false)?.text).toBe('blocked');
    expect(bubbleText(member({ name: 'a', state: 'between' }), false)).toBeNull();
    expect(bubbleText(member({ name: 'a', state: 'away' }), false)).toBeNull();
  });
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

  it('rotates bubbles no faster than every three seconds', () => {
    expect(BUBBLE_MS).toBeGreaterThanOrEqual(3_000);
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
