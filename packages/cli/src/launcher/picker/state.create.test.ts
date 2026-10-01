import { describe, expect, it } from 'vitest';
import { EMPTY_LAUNCHER_FILE, type Seat } from '../store.js';
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
function membersOf(seats: Seat[], agents: string[]): PickerState {
  let s = initialState(
    {
      ...EMPTY_LAUNCHER_FILE,
      snapshot: { taken_at: 0, seats, teams: [{ team: 'acme', here: true }] },
    },
    '',
    0,
  );
  s = reduce(s, { type: 'live', live: {}, status: 'ok', now: 0, agents: { acme: agents } }).state;
  return {
    ...s,
    level: { kind: 'members', team: 'acme', project: 'proj' },
    stack: [{ kind: 'recent' }],
  };
}

describe('picker create flows (ADR 491 §3.4)', () => {
  it('lists team agents with no Workspace here, then + new seat, when you have a seat here', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], ['ada', 'slate']);
    expect(rows(s).map((r) => r.kind + (r.kind === 'team-only' ? `:${r.member}` : ''))).toEqual([
      'heading',
      'seat',
      'seat',
      'heading',
      'team-only:slate',
      'new-seat',
    ]);
  });

  it('without your own seat here, shows how to make one instead', () => {
    const s = membersOf([seat('ada')], ['ada', 'slate']);
    expect(rows(s).at(-1)).toEqual({
      kind: 'hint',
      text: 'set up your own seat here first: musterd human <you>',
    });
  });

  it('⏎ on a team member → confirm → ⇥ harness → ⏎ creates', () => {
    const s = membersOf([seat('ada'), seat('nick', 'human')], ['ada', 'slate']);
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
