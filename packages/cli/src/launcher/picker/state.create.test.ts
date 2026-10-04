import { describe, expect, it } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type MemberEntry, type Seat } from '../store.js';
import { initialState, reduce, rows, type Key, type PickerState } from './state.js';

const seat = (member: string, kind: 'agent' | 'human' = 'agent'): Seat => ({
  address: `acme/proj/${member}`,
  team: 'acme',
  project: 'proj',
  member,
  server: '',
  path: `/w/${member}`,
  kind,
  harnesses: [],
  remote: null,
  last_session: null,
  problem: null,
});
const k = (name: string, extra: Partial<Key> = {}): Key => ({
  name,
  sequence: name.length === 1 ? name : undefined,
  ...extra,
});
function press(s: PickerState, ...keys: Key[]) {
  let state = s;
  for (const key of keys) {
    const r = reduce(state, { type: 'key', key });
    if (r.outcome) return { state: r.state, outcome: r.outcome };
    state = r.state;
  }
  return { state, outcome: null };
}
/** A roster-first row for a member with no folder here (ADR 503). */
const away = (member: string, over: Partial<MemberEntry> = {}): MemberEntry => ({
  team: 'acme',
  member,
  kind: 'agent',
  address: null,
  where: 'nowhere',
  node: null,
  where_label: null,
  can: 'setup',
  ...over,
});
function membersOf(seats: Seat[], members: MemberEntry[]): PickerState {
  let s = initialState(
    {
      ...EMPTY_LAUNCHER_FILE,
      snapshot: { taken_at: 0, seats, teams: [{ team: 'acme', here: true }] },
    },
    '',
    0,
  );
  s = reduce(s, { type: 'live', live: {}, status: 'ok', now: 0, members: { acme: members } }).state;
  return {
    ...s,
    level: { kind: 'members', team: 'acme', project: 'proj' },
    stack: [{ kind: 'recent' }],
  };
}

describe('picker create flows (ADR 491 §3.4)', () => {
  const kinds = (s: PickerState) =>
    rows(s).map((r) =>
      r.kind === 'member'
        ? `member:${r.entry.member}:${r.entry.can}`
        : r.kind === 'heading'
          ? `heading:${r.label}`
          : r.kind,
    );

  it('lists every member once: Workspaces here, then the rest of the team with where/can, then + new seat', () => {
    const s = membersOf(
      [seat('ada'), seat('nick', 'human')],
      [
        away('ada', { address: 'acme/proj/ada', where: 'here', can: 'launch' }),
        away('slate'),
        away('bo', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'wake' }),
        away('cy', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'none' }),
      ],
    );
    expect(kinds(s)).toEqual([
      'heading:on this machine',
      'seat',
      'seat',
      'heading:on the team',
      'member:slate:setup',
      'member:bo:wake',
      'member:cy:none',
      'new-seat',
    ]);
  });

  it('without your own seat here, shows how to make one instead — the team still shows', () => {
    const s = membersOf([seat('ada')], [away('slate')]);
    expect(kinds(s)).toEqual([
      'heading:on this machine',
      'seat',
      'heading:on the team',
      'member:slate:setup',
      'hint',
    ]);
    expect(rows(s).at(-1)).toEqual({
      kind: 'hint',
      text: 'set up your own seat here first: musterd human <you>',
    });
  });

  it('⏎ on a wake row rings the doorbell; ⏎ on a none row does nothing (never a silent move)', () => {
    const bo = away('bo', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'wake' });
    const cy = away('cy', { where: 'node', node: 'n-air', where_label: 'air-2', can: 'none' });
    const s = membersOf([seat('ada'), seat('nick', 'human')], [bo, cy]);
    // rows: ada, nick, bo, cy, + new seat
    expect(press(s, k('down'), k('down'), k('return')).outcome).toEqual({
      kind: 'wake',
      entry: bo,
    });
    const none = press(s, k('down'), k('down'), k('down'), k('return'));
    expect(none.outcome).toBeNull();
    expect(none.state.create).toBeNull();
  });

  it('the snapshot seeds the member rows before any roster answers', () => {
    const s = initialState(
      {
        ...EMPTY_LAUNCHER_FILE,
        snapshot: {
          taken_at: 0,
          seats: [seat('nick', 'human')],
          teams: [{ team: 'acme', here: true }],
          members: [away('slate')],
        },
      },
      '',
      0,
    );
    expect(s.members).toEqual({ acme: [away('slate')] });
  });

  it('⏎ on a team member → confirm → ⇥ harness → ⏎ creates', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], [away('slate')]);
    const at = press(s, k('down'), k('down')).state;
    const confirm = press(at, k('return')).state;
    expect(confirm.create).toMatchObject({ member: 'slate', naming: false, harness: 0 });
    const out = press(confirm, k('tab'), k('return')).outcome;
    expect(out).toEqual({
      kind: 'create',
      team: 'acme',
      project: 'proj',
      member: 'slate',
      harnesses: ['cursor'],
    });
  });

  it('+ new seat asks for a name, validates it, then creates', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], []);
    const naming = press(s, k('down'), k('down'), k('return')).state;
    expect(naming.create).toMatchObject({ naming: true, member: '' });
    const bad = press(naming, k('9'), k('return')).state;
    expect(bad.create?.error).toMatch(/lowercase/);
    const named = press(bad, k('backspace'), k('z'), k('e'), k('d'), k('return')).state;
    expect(named.create).toMatchObject({ naming: false, member: 'zed', error: null });
    expect(press(named, k('return')).outcome).toEqual({
      kind: 'create',
      team: 'acme',
      project: 'proj',
      member: 'zed',
      harnesses: ['claude-code'],
    });
  });

  it('esc cancels a draft', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], []);
    const naming = press(s, k('down'), k('down'), k('return')).state;
    expect(press(naming, k('escape')).state.create).toBeNull();
  });
});
