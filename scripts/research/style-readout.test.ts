import { describe, expect, it } from 'vitest';
import { StylePolicySchema, resolveStyle } from '@musterd/protocol';
import {
  adoption,
  currentEpochFor,
  epochPeriods,
  falsifier,
  lengthByDial,
  lengthDialSetAt,
  periodAt,
  shippedEpoch,
  stanceByEpoch,
  type DirectedAct,
  type HumanRow,
} from './style-readout.js';

/**
 * ADR 514 increment 6 — the three cuts and the falsifier, on hand-made rows. What this guards:
 * the before/after split keys on the audit's dial-set time (never on the dial's current value
 * alone), the epoch timeline collapses non-style policy writes, the adoption denominator counts
 * live AGENT seats, and the falsifier says `met` when nobody set a dial even if the split is empty.
 */
const shipped = StylePolicySchema.parse({});
const D = (n: number) => Date.UTC(2026, 9, n);

const act = (to: string, ts: number, chars: number, from_kind = 'agent'): DirectedAct => ({
  ts,
  to,
  act: 'message',
  body_chars: chars,
  from_kind,
});

describe('epochPeriods', () => {
  it('starts at the shipped epoch and opens a period only when the style epoch moves', () => {
    const periods = epochPeriods([
      { ts: D(1), actor: 'nick', style: undefined }, // a loops knob — style untouched
      { ts: D(2), actor: 'nick', style: { defaults: { length: 'thorough' } } },
      { ts: D(3), actor: 'nick', style: { defaults: { length: 'thorough' } } }, // same epoch
      { ts: D(4), actor: 'dee', style: { floor: { concession_names_check: false } } },
    ]);
    expect(periods.map((p) => [p.from, p.to, p.set_by])).toEqual([
      [0, D(2), null],
      [D(2), D(4), 'nick'],
      [D(4), null, 'dee'],
    ]);
    expect(periods[0]!.epoch).toBe(shippedEpoch());
    expect(periods[1]!.epoch).toBe(
      resolveStyle(StylePolicySchema.parse({ defaults: { length: 'thorough' } })).epoch,
    );
    expect(periodAt(periods, D(3))).toBe(periods[1]);
    expect(periodAt(periods, D(10))).toBe(periods[2]);
  });

  it('a malformed style doc reads as the shipped style, never as a crash', () => {
    const periods = epochPeriods([
      { ts: D(1), actor: 'x', style: { defaults: { length: 'huge' } } },
    ]);
    expect(periods).toHaveLength(1);
  });
});

describe('lengthByDial', () => {
  const humans: HumanRow[] = [
    { name: 'nick', prefs: { length: 'concise' } },
    { name: 'dee', prefs: {} },
  ];
  const prefsSet = [
    { ts: D(5), actor: 'nick', dials: ['bluntness'] }, // not length — does not split
    { ts: D(10), actor: 'nick', dials: ['length'] },
  ];
  const acts = [
    act('nick', D(2), 900),
    act('nick', D(8), 700),
    act('nick', D(11), 200),
    act('nick', D(12), 300),
    act('nick', D(12), 100, 'human'), // nick's own reply to himself: not the block's doing
    act('dee', D(12), 500),
  ];

  it('splits each human before/after the day they set `length`, and buckets by current dial', () => {
    const r = lengthByDial(acts, humans, prefsSet, shipped);
    expect(r.acts_counted).toBe(5);
    expect(r.acts_human_authored).toBe(1);
    const nick = r.per_human.find((h) => h.human === 'nick')!;
    expect(nick.dial).toBe('concise');
    expect(nick.dial_set_at).toBe(D(10));
    expect(nick.before).toEqual({ n: 2, median_chars: 700, p75_chars: 900 });
    expect(nick.after).toEqual({ n: 2, median_chars: 200, p75_chars: 300 });
    const dee = r.per_human.find((h) => h.human === 'dee')!;
    expect(dee.dial).toBe('normal'); // the team default
    expect(dee.dial_set_at).toBeNull();
    expect(dee.after.n).toBe(0);
    expect(r.by_dial.concise.n).toBe(4);
    expect(r.by_dial.normal).toEqual({ n: 1, median_chars: 500, p75_chars: 500 });
    expect(r.by_dial.thorough.n).toBe(0);
  });

  it('lengthDialSetAt keeps the latest set per human and ignores rows naming other dials', () => {
    const at = lengthDialSetAt([
      { ts: D(1), actor: 'nick', dials: ['length'] },
      { ts: D(3), actor: 'nick', dials: ['length', 'format'] },
      { ts: D(4), actor: 'dee', dials: ['format'] },
      { ts: D(5), actor: null, dials: ['length'] },
    ]);
    expect([...at.entries()]).toEqual([['nick', D(3)]]);
  });
});

describe('stanceByEpoch', () => {
  it('summarises the disputes opened inside each period, dropping periods that ended before --since', () => {
    const periods = epochPeriods([{ ts: D(10), actor: 'nick', style: { prose: 'Say less.' } }]);
    const challenge = (id: string, ts: number) => ({
      id,
      seat: 'dolly',
      kind: 'agent',
      act: 'challenge',
      body: 'is that so?',
      meta: null,
      inReplyTo: null,
      parentAct: null,
      parentMeta: null,
      ts,
    });
    const rows = [challenge('a', D(2)), challenge('b', D(11)), challenge('c', D(12))];
    const all = stanceByEpoch(rows, periods, 0);
    expect(all.map((s) => s.cell.opened)).toEqual([1, 2]);
    const late = stanceByEpoch(rows, periods, D(10));
    expect(late).toHaveLength(1);
    expect(late[0]!.cell.opened).toBe(2);
  });
});

describe('adoption', () => {
  const humans: HumanRow[] = [
    { name: 'nick', prefs: { length: 'concise' } },
    { name: 'dee', prefs: {} },
  ];
  const nickEpoch = currentEpochFor(shipped, humans, 'nick');
  const teamEpoch = currentEpochFor(shipped, humans, null); // two humans, no driver ⇒ team

  it("counts live agent seats at their driver's current epoch; humans with a dial over humans", () => {
    const r = adoption(
      humans,
      [
        { seat: 'ada', kind: 'agent', driver: 'nick', style_epoch: nickEpoch },
        { seat: 'lin', kind: 'agent', driver: 'nick', style_epoch: teamEpoch }, // stale: nick set a dial
        { seat: 'bo', kind: 'agent', driver: null, style_epoch: teamEpoch },
        { seat: 'old', kind: 'agent', driver: null, style_epoch: null },
        { seat: 'nick', kind: 'human', driver: null, style_epoch: null }, // not a seat
      ],
      shipped,
    );
    expect(r).toEqual({
      humans: 2,
      humans_with_a_dial: 1,
      live_seats: 4,
      live_seats_current: 2,
      live_seats_unattested: 1,
    });
    expect(nickEpoch).not.toBe(teamEpoch);
  });

  it('with one human on the team, every seat resolves to that human (the only-human rule)', () => {
    const solo: HumanRow[] = [{ name: 'nick', prefs: { length: 'concise' } }];
    expect(currentEpochFor(shipped, solo, null)).toBe(currentEpochFor(shipped, solo, 'nick'));
    expect(currentEpochFor(shipped, solo, 'nobody')).toBe(currentEpochFor(shipped, solo, 'nick'));
  });
});

describe('falsifier', () => {
  const cell = (chars: number[]) => ({
    n: chars.length,
    median_chars: chars.length
      ? chars.sort((a, b) => a - b)[Math.floor((chars.length - 1) / 2)]!
      : null,
    p75_chars: null,
  });
  const lengthWith = (concise: number[], normal: number[]) => ({
    by_dial: { concise: cell(concise), normal: cell(normal), thorough: cell([]) },
    per_human: [],
    acts_counted: concise.length + normal.length,
    acts_human_authored: 0,
  });
  const adopt = (withDial: number) => ({
    humans: 2,
    humans_with_a_dial: withDial,
    live_seats: 1,
    live_seats_current: 1,
    live_seats_unattested: 0,
  });

  it('is MET when no human set a dial, whatever the split', () => {
    expect(falsifier(lengthWith([], [1, 2, 3, 4, 5]), adopt(0)).verdict).toBe('met');
  });

  it('is inconclusive under n ≥ 5 on either side, not-met when concise is shorter, met when it is not', () => {
    expect(falsifier(lengthWith([1, 2], [5, 6, 7, 8, 9]), adopt(1)).verdict).toBe('inconclusive');
    expect(falsifier(lengthWith([1, 2, 3, 4, 5], [5, 6, 7, 8, 9]), adopt(1)).verdict).toBe(
      'not-met',
    );
    expect(falsifier(lengthWith([9, 9, 9, 9, 9], [5, 6, 7, 8, 9]), adopt(1)).verdict).toBe('met');
  });
});
